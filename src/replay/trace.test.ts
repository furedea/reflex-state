import { callFixture, resultFixture } from "../core/test_fixtures.js";
import { parseEvents } from "./trace.js";

test("raw JSONL events are decoded in order and malformed lines identify their location", () => {
  const events = [callFixture(), resultFixture()];
  expect(parseEvents(events.map((event) => JSON.stringify(event)).join("\n") + "\n")).toEqual(
    events,
  );
  expect(() => parseEvents(JSON.stringify(events[0]) + "\n{bad json}")).toThrow("line 2");
  expect(() => parseEvents('{"id":"E0001","type":"tool_result"}')).toThrow("line 1");
});
