// Shared provider config for tests that need opencode to talk to a fake LLM
// over a real HTTP endpoint. Registers a single provider `test` with a single
// model `test-model` (i.e. `--model test/test-model`), pointed at the URL the
// caller supplies (typically a TestLLMServer instance).
//
// Used by:
//   - test/lib/run-process.ts          (subprocess CLI tests)
//   - test/server/httpapi-sdk.test.ts  (in-process SDK tests)
export function testProviderConfig(llmUrl: string) {
  return {
    formatter: false,
    lsp: false,
    // Subprocess tests spawn src/index.ts, which unconditionally sets JOLLICODE_LOCKDOWN=1 and makes
    // config.ts seed `enabled_providers: ["jolli"]` as the bottom layer. Without naming `test` here
    // the lockdown filters this provider out of Provider.list() and every model resolves as
    // "Model not found: test/test-model". Declaring it replaces that floor outright, which is the
    // documented CLI behavior (mergeDeep replaces arrays) that test/config/jolli-lockdown.test.ts pins.
    enabled_providers: ["test"],
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: llmUrl },
      },
    },
  }
}
