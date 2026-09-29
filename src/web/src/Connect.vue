<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ModelView } from "@/api";
import { FMT_ACCENT, type Fmt } from "@/lib/format";
import { toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Copy, Check, Plug, Eye, EyeOff } from "lucide-vue-next";

const { t } = useI18n();

/** Which routing family each connect snippet belongs to. */
const SNIPPET_FMT: Record<string, Fmt> = {
  openai: "openai",
  responses: "responses",
  anthropic: "anthropic",
  curl: "openai",
  "curl-anthropic": "anthropic",
  "curl-responses": "responses",
};
function snippetAccent(key: string) {
  const f = SNIPPET_FMT[key];
  return f ? FMT_ACCENT[f] : null;
}

const apiKey = ref<string | null>(null);
const lanIp = ref<string | null>(null);
const copied = ref("");
const showKey = ref(false);
/** Existing models, so the curl snippets can name a real model instead of the
 *  "<model>" placeholder — copy, paste, run, no editing. */
const models = ref<ModelView[]>([]);

// An agent runs on another machine, so localhost is useless to it: when the UI
// was opened via localhost, show the host's LAN IP instead. If the user already
// reached the UI by IP, just echo that address back.
const baseUrl = computed(() => {
  const host = window.location.hostname;
  if ((host === "localhost" || host === "127.0.0.1") && lanIp.value) {
    const port = window.location.port;
    return `${window.location.protocol}//${lanIp.value}${port ? ":" + port : ""}`;
  }
  return window.location.origin;
});
// Each protocol points at its own surface: OpenAI chat tools at /openai-chat/v1
// (their SDK appends /chat/completions, /models), responses clients (codex &
// co.) at /openai-responses/v1 (their SDK appends /responses, /models);
// Anthropic tools at /anthropic (their SDK appends /v1/messages, /v1/models).
const baseUrlOpenaiChat = computed(() => `${baseUrl.value}/openai-chat/v1`);
const baseUrlOpenaiResponses = computed(() => `${baseUrl.value}/openai-responses/v1`);
const baseUrlAnthropic = computed(() => `${baseUrl.value}/anthropic`);

async function load() {
  apiKey.value = (await req<{ apiKey: string }>("GET", "/admin/api-key")).apiKey;
  lanIp.value = (await req<{ lanIp: string | null }>("GET", "/admin/connection")).lanIp;
  models.value = (await req<{ models: ModelView[] }>("GET", "/admin/models").catch(() => ({ models: [] }))).models;
}

/** First model enabled for a routing family — the snippet's example model. */
function exampleModel(f: Fmt): string {
  return models.value.find((m) => m[f].enabled)?.name || "<model>";
}

async function copy(key: string, text: string) {
  const ok = await copyText(text);
  if (ok) {
    copied.value = key;
    setTimeout(() => {
      if (copied.value === key) copied.value = "";
    }, 1500);
  } else {
    toast(t("connect.copyFailed"), "error");
  }
}

const snippets = computed(() => [
  {
    key: "openai",
    title: t("connect.openaiTitle"),
    text: `export OPENAI_BASE_URL=${baseUrlOpenaiChat.value}\nexport OPENAI_API_KEY=${apiKey.value ?? ""}`,
  },
  {
    key: "responses",
    title: t("connect.responsesExportTitle"),
    text: `export OPENAI_BASE_URL=${baseUrlOpenaiResponses.value}\nexport OPENAI_API_KEY=${apiKey.value ?? ""}`,
  },
  {
    key: "anthropic",
    title: t("connect.anthropicTitle"),
    text: `export ANTHROPIC_BASE_URL=${baseUrlAnthropic.value}\nexport ANTHROPIC_API_KEY=${apiKey.value ?? ""}`,
  },
  {
    key: "curl",
    title: t("connect.curlTitle"),
    text: `curl ${baseUrlOpenaiChat.value}/chat/completions \\\n  -H "Authorization: Bearer ${apiKey.value ?? ""}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${exampleModel("openai")}","messages":[{"role":"user","content":"hi"}]}'`,
  },
  {
    key: "curl-anthropic",
    title: t("connect.curlAnthropicTitle"),
    text: `curl ${baseUrlAnthropic.value}/v1/messages \\\n  -H "Authorization: Bearer ${apiKey.value ?? ""}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${exampleModel("anthropic")}","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'`,
  },
  {
    key: "curl-responses",
    title: t("connect.responsesTitle"),
    text: `curl ${baseUrlOpenaiResponses.value}/responses \\\n  -H "Authorization: Bearer ${apiKey.value ?? ""}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${exampleModel("responses")}","input":"hi"}'`,
  },
]);

onMounted(load);
</script>

<template>
  <div class="space-y-4">
    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-base">
          <Plug class="h-4 w-4 text-primary" />
          {{ t("connect.title") }}
        </CardTitle>
        <CardDescription>{{ t("connect.desc") }}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <!-- Base URL: one address per protocol (OpenAI chat at /openai-chat/v1, responses at /openai-responses/v1; Claude/Anthropic at /anthropic) -->
        <div class="space-y-2">
          <div class="flex items-center justify-between gap-3 rounded-lg border p-3" :class="[FMT_ACCENT.openai.border, FMT_ACCENT.openai.soft]">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5 text-xs font-medium" :class="FMT_ACCENT.openai.text">
                <span class="h-1.5 w-1.5 rounded-full" :class="FMT_ACCENT.openai.solid" />
                {{ t("connect.baseUrlOpenai") }}
              </div>
              <div class="mt-0.5 truncate font-mono text-sm">{{ baseUrlOpenaiChat }}</div>
            </div>
            <Button variant="outline" size="sm" @click="copy('url-openai', baseUrlOpenaiChat)">
              <Check v-if="copied === 'url-openai'" class="h-4 w-4" />
              <Copy v-else class="h-4 w-4" />
              {{ copied === "url-openai" ? t("connect.copied") : t("connect.copy") }}
            </Button>
          </div>
          <div class="flex items-center justify-between gap-3 rounded-lg border p-3" :class="[FMT_ACCENT.responses.border, FMT_ACCENT.responses.soft]">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5 text-xs font-medium" :class="FMT_ACCENT.responses.text">
                <span class="h-1.5 w-1.5 rounded-full" :class="FMT_ACCENT.responses.solid" />
                {{ t("connect.baseUrlResponses") }}
              </div>
              <div class="mt-0.5 truncate font-mono text-sm">{{ baseUrlOpenaiResponses }}</div>
            </div>
            <Button variant="outline" size="sm" @click="copy('url-responses', baseUrlOpenaiResponses)">
              <Check v-if="copied === 'url-responses'" class="h-4 w-4" />
              <Copy v-else class="h-4 w-4" />
              {{ copied === "url-responses" ? t("connect.copied") : t("connect.copy") }}
            </Button>
          </div>
          <div class="flex items-center justify-between gap-3 rounded-lg border p-3" :class="[FMT_ACCENT.anthropic.border, FMT_ACCENT.anthropic.soft]">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5 text-xs font-medium" :class="FMT_ACCENT.anthropic.text">
                <span class="h-1.5 w-1.5 rounded-full" :class="FMT_ACCENT.anthropic.solid" />
                {{ t("connect.baseUrlAnthropic") }}
              </div>
              <div class="mt-0.5 truncate font-mono text-sm">{{ baseUrlAnthropic }}</div>
            </div>
            <Button variant="outline" size="sm" @click="copy('url-anthropic', baseUrlAnthropic)">
              <Check v-if="copied === 'url-anthropic'" class="h-4 w-4" />
              <Copy v-else class="h-4 w-4" />
              {{ copied === "url-anthropic" ? t("connect.copied") : t("connect.copy") }}
            </Button>
          </div>
        </div>
        <p class="text-xs text-muted-foreground">{{ t("connect.note") }}</p>
        <!-- API Key (what agents put in their 'api key' field) -->
        <div class="flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
          <div class="min-w-0">
            <div class="text-xs font-medium text-primary">{{ t("connect.apiKey") }}</div>
            <div class="truncate font-mono text-sm">
              {{ apiKey ? (showKey ? apiKey : "•".repeat(Math.min(apiKey.length, 24))) : "…" }}
            </div>
          </div>
          <div class="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              :title="showKey ? t('connect.hide') : t('connect.reveal')"
              :aria-label="showKey ? t('connect.hide') : t('connect.reveal')"
              @click="showKey = !showKey"
            >
              <EyeOff v-if="showKey" class="h-4 w-4" />
              <Eye v-else class="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" @click="copy('key', apiKey ?? '')">
              <Check v-if="copied === 'key'" class="h-4 w-4" />
              <Copy v-else class="h-4 w-4" />
              {{ copied === "key" ? t("connect.copied") : t("connect.copy") }}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>

    <Card v-for="s in snippets" :key="s.key">
      <CardHeader class="flex flex-row items-center justify-between space-y-0">
        <CardTitle class="flex items-center gap-2 text-sm font-medium">
          <span v-if="snippetAccent(s.key)" class="h-1.5 w-1.5 rounded-full" :class="snippetAccent(s.key)?.solid" />
          {{ s.title }}
        </CardTitle>
        <Button variant="ghost" size="sm" @click="copy(s.key, s.text)">
          <Check v-if="copied === s.key" class="h-4 w-4" />
          <Copy v-else class="h-4 w-4" />
          {{ copied === s.key ? t("connect.copied") : t("connect.copy") }}
        </Button>
      </CardHeader>
      <CardContent>
        <pre class="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">{{ s.text }}</pre>
      </CardContent>
    </Card>
  </div>
</template>
