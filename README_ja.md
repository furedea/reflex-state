# ReflexState

**Pi に，確認・再生できるワーキングメモリを．**

[English](README.md) | 日本語

ReflexState は，現在の目標，変更したファイル，テスト結果，作業を妨げている問題を，
エージェントのコンテキストに引き継ぐ [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
拡張です．実行中のイベントから作業状態を組み立て，状態の変化とその根拠を結び付けます．

- **作業状態を次の推論へ．** 現在の実行とコンパクトな状態ブロックをモデルに渡します．
  完全なセッション履歴はディスクに保持します．
- **何が，なぜ変わったかを確認．** `/state` と `/state history` で状態と変化を確認できます．
  各状態遷移には，元のイベントと更新に使った判定を記録します．
- **状態の変化を再現．** セッションをエクスポートし，記録済みの判定を使って状態更新を再生できます．
  再生時にモデルを呼び出したり，ツールを再実行したりする必要はありません．

状態の管理は，Pi の推論モデルから独立しています．ファイル変更や test／build／lint の結果は
コードで追跡し，任意の TypeSafe Jev がエラーの分類やタスクの完了を判定します．
ReflexState は文章の要約を生成せず，構造化された状態を維持します．

**アルファ版：** [ローカルで試す](#ローカルでの起動)．追加の API キーなしで始められます．
現在の確認範囲は [検証と制限](#検証と制限) を参照してください．

## プレビュー版のインストール

npm からのインストールには，最初のプレビュー版の公開が必要です．公開前は，後述の
ローカル実行の手順を使ってください．Pi をインストール済みの場合は，次を実行します．

```sh
pi install npm:reflex-state@next
REFLEX_STATE_DISABLE_JEV=1 pi
```

`/state` で現在の目標，変更したファイル，検証結果，障害を確認できます．
TypeSafe のキーなしでも利用でき，Jev は任意で追加できます．Node.js 22.19 以降が必要です．
動作確認済みの Pi は 0.83.0 です．

## ローカルでの起動

Node.js 22.19 以降，pnpm 10.33.0，Pi 0.83.0 を使用します．依存バージョンは固定しています．
Pi は開発依存であり，実行時の依存は TypeSafe SDK 0.6.0 のみです．

```sh
pnpm install --ignore-scripts
REFLEX_STATE_DISABLE_JEV=1 pnpm exec pi
```

Pi でこのチェックアウトを信頼すると，`.pi/extensions/reflex_state.ts` が自動で読み込まれます．
別のプロジェクトから利用する場合など，パスを明示して読み込むには次を実行します．

```sh
REFLEX_STATE_DISABLE_JEV=1 pnpm exec pi --no-extensions -e ./src/pi/index.ts
```

このコマンドは，このチェックアウトで二つのエントリーが重複して読み込まれないよう，
拡張の自動検出を無効にします．別のディレクトリから起動する場合は，
`src/pi/index.ts` の絶対パスを指定してください．Pi 本体の変更は不要です．

Jev を有効にするには，環境変数で `TYPESAFE_API_KEY` を渡し，
`REFLEX_STATE_DISABLE_JEV=1` を外します．キーは SDK が読み取り，
ReflexState の設定ファイルに含まれるキーは拒否されます．
認証情報がない場合や認証に失敗した場合は，そのランタイムの Jev を無効にして一度通知します．
決定論的な状態更新は継続します．認証情報の修正後に `/state jev on` を実行すると，
更新処理を新しく作成して再開できます．

## アーキテクチャ

| コンポーネント                        | 役割                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/core/`                           | 生イベント，純粋な抽出処理，閾値に基づく判定の適用，reducer，イベントの直列処理，メトリクス  |
| `src/typesafe/`                       | 個別の Choice／Noul 質問，機密情報のマスキング，信頼度の閾値，時間制限，サーキットブレーカー |
| `src/pi/`                             | Pi のフック，分岐の状態復元，コマンド，ウィジェット，一時的なコンテキスト投影                |
| `src/replay/`                         | エクスポート済みイベントと記録済み判定への，共通の状態更新処理の適用                         |
| `src/composition.ts` と実行エントリー | core のインターフェースを介したアダプターの組み立て                                          |

イベントを処理するたびに，`reflex-state.transition` カスタムエントリーを追記します．
各エントリーには，イベント，更新後の状態，適用した設定，作業ディレクトリ，判定を保存します．
復元対象は，Pi の現在の分岐における直近のリセット以降の記録です．
ID はリセットや分岐の切り替えをまたいでも単調に増加します．
通常実行と再生は同じ reducer を使い，core は Pi や TypeSafe のコードを import しません．

コンテキスト投影では，実行途中の追加指示と，対応がそろったツール呼び出し・結果を含めて，
現在の実行全体を保持します．そのうえで，末尾のユーザーメッセージまたはツール結果に，
サイズ制限付きの `<reflex-state>` テキストブロックを追加します．
ブロックには，状態，最近の依頼，失敗の根拠となる原文の抜粋を含めます．
投影が変更するのは送信用のコンテキストだけで，Pi のセッションログを書き換えたり削除したりしません．
ツール呼び出しと結果の対応が不完全な場合，現在の依頼文がない場合，コンテキスト圧縮中，
またはブロックのサイズ上限に収まらない場合は，元のコンテキストを保持します．

## 設定と操作

設定は，デフォルト，全体設定，信頼済みプロジェクトの設定，環境変数，セッション中の切り替えの順に優先されます．
全体設定は `~/.pi/agent/reflex-state.json` です．Pi のディレクトリを変更している場合は，
`$PI_CODING_AGENT_DIR/reflex-state.json` を使います．
プロジェクト設定は `.pi/reflex-state.json` で，信頼済みのプロジェクトだけで読み込みます．
分岐の切り替えなどでランタイムを復元すると，有効・無効の設定も設定ファイルと環境変数から再適用されます．

プロジェクト設定の例：

```json
{
  "projection": { "placement": "last-message" },
  "verificationCommands": { "test": ["^make check$"] }
}
```

コマンドの正規表現を追加すると，組み込みの test／build／lint の検出を拡張できます．
不明なキーには警告を出します．型，閾値，上限値，正規表現が不正な場合や認証情報を含む場合は，
その設定ファイルを拒否してデフォルトに戻します．
全デフォルト値は [core/config.ts](https://github.com/furedea/reflex-state/blob/main/src/core/config.ts) と
[設定の仕様](https://github.com/furedea/reflex-state/blob/main/docs/spec/reflex_state_v0.1_spec_claude.md#21-configuration) を参照してください．

| 操作                         | 動作                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `/state`                     | 現在の依頼への参照，作業フェーズ，ファイル，検証結果，障害，作業用イベント集合を表示 |
| `/state history [n]`         | 最近の状態遷移と判定の適用状況を表示                                                 |
| `/state stats`               | 実測の使用量，待ち時間，投影の件数，更新処理の稼働状態を表示                         |
| `/state debug`               | 最新の意味判定，質問 ID，元の確率値を表示                                            |
| `/state reset`               | 確認後にリセットマーカーを追記し，作業用の状態をクリア                               |
| `/state projection on\|off`  | 現在のランタイムのコンテキスト投影を切り替え                                         |
| `/state jev on\|off`         | 現在のランタイムの意味判定を切り替え                                                 |
| `REFLEX_STATE_DISABLE=1`     | 状態の記録と投影を無効化                                                             |
| `REFLEX_STATE_DISABLE_JEV=1` | 決定論的な更新だけで起動                                                             |
| `REFLEX_STATE_PROJECTION=0`  | Pi の元のコンテキストを使って起動                                                    |

Jev のデフォルトは，SDK のタイムアウトが 3 秒，リトライなし，外側の処理期限が 4 秒です．
Pi のキャンセルとも連動します．3 回連続で失敗すると，サーキットブレーカーが 60 秒間リクエストを停止します．
その後の試行が成功すれば通常動作に戻ります．認証失敗時は，更新処理を作り直すまで無効になります．
不確かな回答は意味判定による状態変更に適用しません．
作業フェーズの質問は，必要な質問に添えて比較用に記録するだけで，作業フェーズを直接変更しません．

## TypeSafe に送信するデータ

Jev が有効な場合，必要な判定のために，長さを制限したユーザーの依頼文，現在の型付き状態，
ファイルパス，関連する bash／edit／write の結果の抜粋を送信します．
完了を判定する際は，長さを制限したアシスタントの最終応答も送ります．
JSON 入力の上限は 24,000 バイトです．read／grep／find／ls の結果では Jev を呼び出さず，
それらの出力文を他のリクエストに含めることもありません．

一般的な認証情報のパターン，Bearer 認証情報，秘密鍵のブロック，環境変数への代入は，送信前にマスキングします．
これはパターンに基づく処理であり，あらゆる機密情報を検出できる保証はありません．
テストエラーなどのツール出力にソースコードが含まれる場合もあります．
ローカルの状態遷移記録は，サイズ制限付きの入力と抜粋を保持します．
送信時のマスキングは，Pi の元の履歴を書き換えません．
SDK のログにはリクエストやレスポンスの内容を含めません．
不正なレスポンスについて記録するのは，想定フィールドの型だけで，想定外の応答値は記録しません．

## エクスポートと再生

公開済みパッケージからは，リポジトリを clone せずに実行できます．

```sh
npm exec --package=reflex-state@next -- reflex-state-export /path/to/session.jsonl --out trace-output
npm exec --package=reflex-state@next -- reflex-state-replay trace-output/events.jsonl --updater noop --out replay-output
```

ローカルのチェックアウトから実行する場合は，次を使います．

```sh
pnpm export-trace /path/to/session.jsonl --out trace-output
pnpm replay trace-output/events.jsonl --updater noop --out replay-output
pnpm replay trace-output/events.jsonl --updater recorded --out replay-recorded
```

エクスポートは，最後に保存された末端エントリー，または `--leaf <entry-id>` で指定したエントリーまでの分岐をたどります．
ReflexState の状態遷移がある場合は，直近のリセット以降の元イベントと判定を取り出します．
状態遷移がないセッションは，Pi のメッセージエントリーから正規化します．
元のファイルを変更せず，`events.jsonl`，`transitions.jsonl`，`trace_meta.json` を出力します．

replay は，`final_state.json`，`transitions.jsonl`，`metrics.json`，`summary.txt` を出力します．
`noop` は決定論的に処理し，`jev` は意味判定のために実 API を呼び出します．
`recorded` は同じディレクトリの `transitions.jsonl` を読み込みます．
別の記録を使うには，`--updater recorded:/path/to/transitions.jsonl` を指定します．
イベントの一致を確認し，記録済みの設定，作業ディレクトリ，タイムスタンプ，判定を再利用して最終状態を再現します．
判定ログが必要なため，ReflexState の記録がない Pi セッションだけでは recorded 再生はできません．

通常の再生では，`--config <file>` と `--cwd <directory>` で設定と作業ディレクトリを指定できます．
指定がなく，エクスポートしたメタデータがある場合は，そこに含まれる値を使います．
recorded モードでは，各状態遷移に記録された設定を使います．
使用量が取得できない場合は推定せず，`/state stats` では `n/a` と表示し，JSON では省略します．
Jev の呼び出し回数は，失敗を含むクライアント呼び出しの回数であり，課金対象になった回数ではありません．

## 検証と制限

```sh
pnpm check
pnpm build
pnpm package:check
REFLEX_STATE_LIVE_JEV=1 pnpm exec vitest run src/typesafe/live_contract.test.ts
```

最後のコマンドは `TYPESAFE_API_KEY` を必要とし，実際の System One リクエストを 1 回送信します．
このテストはデフォルトではスキップします．
オフラインのテストでは，決定論的な動作，判定の適用条件，マスキング，時間制限，障害時の処理，
投影，分岐，記録に基づく完全な再生を確認します．
Pi のスモークテストは，モデルへのネットワーク通信を無効にして，0.83.0 の実際のローダー，
拡張ランナー，ローカルの write／edit／bash ツール，ディスク保存するセッションマネージャーを使います．
パスの明示指定と，信頼済みプロジェクトの `.pi/extensions` の自動検出の両方を確認します．

現在の制限：

- 過去の実行は投影後のコンテキストから除外します．保持した状態とサイズ制限付きの抜粋だけが引き継がれるため，
  有用な文脈を失う可能性があります．トークンの削減やタスク成功率の向上を実証したものではありません．
- bash によるファイル変更は追跡しません．変更ファイルを更新するのは，成功した Pi の edit／write の結果と，
  明示的な `file_change` イベントだけです．
- 検証コマンドの検出はヒューリスティックであり，シェル構文の解析ではありません．
  複合コマンドでは test > build > lint の優先順で一つの種類を選び，コマンド全体の結果を記録します．
  各部分が実行されたことまでは保証しません．
- 閾値は未校正のヒューリスティックです．実際の Jev の出力は変動し得るため，
  意味判定を厳密に再現できるのは記録済みの判定を使う場合だけです．
- 状態ブロックと作業用イベント集合には上限があります．v0.1 には，過去の根拠を取り出す recall ツール，
  現在の実行内の履歴削減，ベンチマーク基盤，他のエージェント用のアダプターはありません．
- Pi は最初のアシスタントメッセージまで，新規セッションファイルの作成を遅延します．
  ReflexState は Pi の追記 API を使うため，同じ保存動作に従います．
- TypeSafe の実リクエスト，プロバイダーを使った対話実行，Anthropic・OpenAI 互換・Google API を介した
  複数テキストブロックのツール結果の送受信は，ここでは未検証です．
  プロバイダーが追加したツール結果ブロックを拒否する場合は，`projection.placement` を `run-start` にするか，
  投影を無効にしてください．`run-start` はプロンプトキャッシュの再利用を減らす可能性があります．

要件の正本は [レビュー済み仕様書](https://github.com/furedea/reflex-state/blob/main/docs/spec/reflex_state_v0.1_spec_claude.md) です．
[元の草案](https://github.com/furedea/reflex-state/blob/main/docs/spec/reflex_state_v0.1_spec_gpt6_pro.md) は履歴資料として保存しています．
[Phase 0 の調査結果](https://github.com/furedea/reflex-state/blob/main/docs/spec/phase0_findings.md) に互換性の確認根拠と未実施の実通信チェックを，
[ADR-0002](https://github.com/furedea/reflex-state/blob/main/docs/adr/0002_compose_adapters_at_entry_points.md) にアダプターの組み立て方針を記載しています．
