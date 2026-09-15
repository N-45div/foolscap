import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReadiness, readinessReport } from "../server/doctor.mjs";

test("doctor reports provider absence and configured model choices honestly", () => {
  const report = readinessReport({
    PATH: "",
    PATHEXT: ".EXE;.CMD",
    FOOLSCAP_COORDINATOR_MODEL: "gpt-6-astra",
    FOOLSCAP_COORDINATOR_MODELS: "gpt-5.6-terra",
    FOOLSCAP_VOICE_BACKEND_MODEL: "gpt-5.6-luna",
  });

  assert.equal(report.launchReady, false);
  assert.equal(report.provider.ready, false);
  assert.equal(report.voice.liveModel, "gpt-live-1");
  assert.deepEqual(report.coordinator.models.slice(0, 2), ["gpt-6-astra", "gpt-5.6-terra"]);
  assert.match(formatReadiness(report), /OPENAI_API_KEY is not set/);
  assert.match(formatReadiness(report), /launch\s+blocked/);
});
