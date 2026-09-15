import { DEFAULT_MODEL, configuredModels } from "./coordinator.mjs";
import { fleetAgentCatalog } from "./fleet.mjs";
import { LIVE_MODEL, voiceModels } from "./live-api.mjs";

const familyOf = (id) => id === "claude-acp" ? "claude" : id;

/** Read launch prerequisites without starting an agent or making a network call. */
export function readinessReport(env = process.env) {
  const agents = fleetAgentCatalog(env);
  const readyFamilies = [...new Set(
    agents.filter((agent) => agent.status === "ready").map((agent) => familyOf(agent.id)),
  )];
  const providerReady = Boolean(env.OPENAI_API_KEY);
  const coordinatorModel = env.FOOLSCAP_COORDINATOR_MODEL || DEFAULT_MODEL;
  const coordinatorModels = configuredModels(coordinatorModel, env.FOOLSCAP_COORDINATOR_MODELS);
  const backendModels = voiceModels({ env });
  const reviewReady = readyFamilies.length >= 2;

  return {
    launchReady: providerReady && reviewReady,
    provider: {
      ready: providerReady,
      reason: providerReady ? null : "OPENAI_API_KEY is not set",
    },
    coordinator: {
      ready: providerReady,
      model: coordinatorModel,
      models: coordinatorModels,
      maxOutputTokens: 1200,
      budgetEnforcement: "observed",
    },
    voice: {
      serverReady: providerReady,
      liveModel: LIVE_MODEL,
      backendModel: backendModels[0],
      backendModels,
      runtimeCheck: "Start a voice session in a browser with microphone permission.",
    },
    review: {
      ready: reviewReady,
      readyFamilies,
      reason: reviewReady ? null : "two different ready agent families are required for independent review",
    },
    agents,
  };
}

export function formatReadiness(report) {
  const mark = (ready) => ready ? "ready" : "setup";
  const lines = [
    `provider     ${mark(report.provider.ready)}${report.provider.reason ? ` · ${report.provider.reason}` : ""}`,
    `coordinator  ${mark(report.coordinator.ready)} · ${report.coordinator.model} · max ${report.coordinator.maxOutputTokens} output tokens · ${report.coordinator.budgetEnforcement} budget`,
    `voice        ${mark(report.voice.serverReady)} · ${report.voice.liveModel} → ${report.voice.backendModel}`,
    `review       ${mark(report.review.ready)} · ${report.review.readyFamilies.join(" + ") || report.review.reason}`,
    "agents",
    ...report.agents.map((agent) => `  ${agent.id.padEnd(13)} ${agent.status}${agent.reason ? ` · ${agent.reason}` : ""}`),
    `launch       ${report.launchReady ? "ready" : "blocked"}`,
  ];
  return lines.join("\n");
}
