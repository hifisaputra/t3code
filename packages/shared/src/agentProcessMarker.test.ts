import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_PROCESS_THREAD_ENV,
  readAgentProcessMarker,
  withAgentProcessMarker,
} from "./agentProcessMarker.ts";

describe("withAgentProcessMarker", () => {
  it("adds the thread marker while keeping the rest of the environment", () => {
    const env = withAgentProcessMarker({ PATH: "/usr/bin", CODEX_HOME: undefined }, "thread-7");
    expect(env).toEqual({
      PATH: "/usr/bin",
      CODEX_HOME: undefined,
      [AGENT_PROCESS_THREAD_ENV]: "thread-7",
    });
  });

  it("replaces a marker inherited from the server's own environment", () => {
    const env = withAgentProcessMarker({ [AGENT_PROCESS_THREAD_ENV]: "stale" }, "thread-7");
    expect(env[AGENT_PROCESS_THREAD_ENV]).toBe("thread-7");
  });
});

describe("readAgentProcessMarker", () => {
  it("reads the marker out of an environment dump", () => {
    expect(
      readAgentProcessMarker(["PATH=/usr/bin", `${AGENT_PROCESS_THREAD_ENV}=thread-7`, "HOME=/x"]),
    ).toBe("thread-7");
  });

  it("round-trips what withAgentProcessMarker wrote", () => {
    const env = withAgentProcessMarker({ PATH: "/usr/bin" }, "thread-7");
    const entries = Object.entries(env).map(([key, value]) => `${key}=${value}`);
    expect(readAgentProcessMarker(entries)).toBe("thread-7");
  });

  it("returns undefined when the variable is absent or empty", () => {
    expect(readAgentProcessMarker(["PATH=/usr/bin"])).toBeUndefined();
    expect(readAgentProcessMarker([`${AGENT_PROCESS_THREAD_ENV}=`])).toBeUndefined();
    expect(readAgentProcessMarker([`${AGENT_PROCESS_THREAD_ENV}=   `])).toBeUndefined();
  });

  it("rejects a value with whitespace, which macOS `ps -E` cannot round-trip", () => {
    expect(readAgentProcessMarker([`${AGENT_PROCESS_THREAD_ENV}=thread 7`])).toBeUndefined();
  });

  it("ignores variables that merely start with the marker name", () => {
    expect(readAgentProcessMarker([`${AGENT_PROCESS_THREAD_ENV}_EXTRA=thread-7`])).toBeUndefined();
  });
});
