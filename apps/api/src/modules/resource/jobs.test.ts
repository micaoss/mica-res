import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Platform, PlatformScheduler } from "@/platform";
import type { Logger } from "@/shared/lib/logger";
import { afterEach, describe, expect, test } from "bun:test";
import { getPlatform, setPlatform } from "@/platform";
import { startResourceJobs, stopResourceJobs } from "./jobs";

function recordingScheduler(): PlatformScheduler & { names: string[]; delays: number[] } {
  const names: string[] = [];
  const delays: number[] = [];
  return {
    names,
    delays,
    every(name, opts) {
      names.push(name);
      delays.push(opts.delayMs);
      return { stop: async () => {} };
    },
    stopAll: async () => {},
  };
}

const original = getPlatform();
const logger = { info() {}, warn() {}, error() {} } as unknown as Logger;

afterEach(async () => {
  await stopResourceJobs();
  setPlatform(original);
});

describe("startResourceJobs", () => {
  test("registers once per scheduler, and again on a new one", () => {
    const first = recordingScheduler();
    setPlatform({ ...original, scheduler: first } as Platform);
    startResourceJobs({} as AppDatabase, {} as Config, logger);
    startResourceJobs({} as AppDatabase, {} as Config, logger);
    expect(first.names).toEqual(["resource-jobs"]);

    // A Durable Object constructed again in the same isolate brings a new
    // scheduler; the jobs must follow it.
    const second = recordingScheduler();
    setPlatform({ ...original, scheduler: second } as Platform);
    startResourceJobs({} as AppDatabase, {} as Config, logger);
    expect(second.names).toEqual(["resource-jobs"]);
  });

  test("runs at once on Workers, where an alarm wakes a fresh instance", () => {
    const scheduler = recordingScheduler();
    setPlatform({ ...original, name: "workers", scheduler } as Platform);
    startResourceJobs({} as AppDatabase, {} as Config, logger);
    expect(scheduler.delays).toEqual([0]);
  });
});
