<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ProviderPublic } from "@/api";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Loader2, ServerCog, ChevronDown, Info } from "lucide-vue-next";

/** Unified create/edit dialog for a source (the Sources page's only write
 *  surface — mirrors the Model editor's modal pattern). `provider` null =
 *  create; on save it emits the server's canonical row. */
const props = defineProps<{ provider: ProviderPublic | null }>();
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ saved: [ProviderPublic] }>();

const { t } = useI18n();

const name = ref("");
const baseUrlOpenai = ref("");
const baseUrlAnthropic = ref("");
const apiKey = ref("");
const rpm = ref("");
const fmtOpenai = ref(true);
const fmtAnthropic = ref(false);
const responses = ref(false);
const showBaseHelp = ref(false);
const err = ref("");
const saving = ref(false);

/** Toggle a format checkbox, but never let both be turned off. */
function toggleFmt(which: "openai" | "anthropic") {
  if (which === "openai") {
    if (fmtOpenai.value && !fmtAnthropic.value) return;
    fmtOpenai.value = !fmtOpenai.value;
  } else {
    if (fmtAnthropic.value && !fmtOpenai.value) return;
    fmtAnthropic.value = !fmtAnthropic.value;
  }
}

const formats = (): string[] => {
  const out: string[] = [];
  if (fmtOpenai.value) out.push("openai");
  if (fmtAnthropic.value) out.push("anthropic");
  return out;
};

function init() {
  err.value = "";
  showBaseHelp.value = false;
  const p = props.provider;
  if (!p) {
    name.value = "";
    baseUrlOpenai.value = "";
    baseUrlAnthropic.value = "";
    apiKey.value = "";
    rpm.value = "";
    fmtOpenai.value = true;
    fmtAnthropic.value = false;
    responses.value = false;
    return;
  }
  name.value = p.name;
  baseUrlOpenai.value = p.baseUrlOpenai;
  baseUrlAnthropic.value = p.baseUrlAnthropic;
  apiKey.value = "";
  rpm.value = p.rpm ? String(p.rpm) : "";
  fmtOpenai.value = p.formats.includes("openai");
  fmtAnthropic.value = p.formats.includes("anthropic");
  responses.value = !!p.supportsResponses;
}

watch(open, (o) => {
  if (o) init();
});

function validate(): boolean {
  if (!formats().length) err.value = t("sources.errFormat");
  else if (!props.provider && (!name.value.trim() || !apiKey.value)) err.value = t("sources.errRequired");
  else if (props.provider && !name.value.trim()) err.value = t("sources.errNameRequired");
  else if ((fmtOpenai.value && !baseUrlOpenai.value.trim()) || (fmtAnthropic.value && !baseUrlAnthropic.value.trim()))
    err.value = t("sources.errBaseUrl");
  else {
    err.value = "";
    return true;
  }
  return false;
}

async function save() {
  if (saving.value) return;
  if (!validate()) return;
  saving.value = true;
  try {
    const body: Record<string, unknown> = {
      name: name.value.trim(),
      baseUrlOpenai: baseUrlOpenai.value.trim(),
      baseUrlAnthropic: baseUrlAnthropic.value.trim(),
      formats: formats(),
      supportsResponses: fmtOpenai.value && responses.value,
      rpm: Number(rpm.value) || 0,
    };
    // Create validates the key as required, so it always lands in the body;
    // edit only sends it when a new one was entered (blank = keep current).
    if (apiKey.value) body.apiKey = apiKey.value;
    const r = props.provider
      ? await req<{ provider: ProviderPublic }>("PUT", `/admin/providers/${props.provider.id}`, body)
      : await req<{ provider: ProviderPublic }>("POST", "/admin/providers", body);
    toast(t(props.provider ? "sources.updated" : "sources.added"), "success");
    open.value = false;
    emit("saved", r.provider);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-lg">
      <div class="flex shrink-0 items-center gap-2 pr-8">
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
          <ServerCog class="h-4 w-4" />
        </span>
        <div class="min-w-0">
          <DialogTitle class="text-base">{{ provider ? t("sources.editTitle") : t("sources.add") }}</DialogTitle>
          <DialogDescription>{{ provider ? t("sources.dialogEditDesc") : t("sources.dialogCreateDesc") }}</DialogDescription>
        </div>
      </div>

      <div class="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-1 py-1">
        <div class="space-y-1.5">
          <Label for="s-name">{{ t("sources.nameLabel") }}</Label>
          <Input id="s-name" v-model="name" :placeholder="t('sources.namePh')" autocomplete="off" aria-label="name" />
        </div>

        <div class="space-y-1.5">
          <Label>{{ t("sources.formats") }}</Label>
          <div class="space-y-2 rounded-md border bg-background/50 p-3">
            <div class="space-y-2">
              <div class="flex items-center gap-2.5">
                <Checkbox
                  :model-value="fmtOpenai"
                  :disabled="fmtOpenai && !fmtAnthropic"
                  aria-label="openai"
                  @update:model-value="toggleFmt('openai')"
                />
                <span class="text-sm font-medium leading-none">openai</span>
                <span class="text-xs text-muted-foreground">/chat/completions</span>
              </div>
              <div class="flex items-center gap-2.5 pl-7">
                <Checkbox v-model="responses" :disabled="!fmtOpenai" :aria-label="t('sources.responses')" />
                <span class="text-sm leading-none" :class="fmtOpenai ? '' : 'text-muted-foreground'">{{ t("sources.responses") }}</span>
                <span class="text-xs text-muted-foreground">/responses</span>
              </div>
            </div>
            <Separator />
            <div class="flex items-center gap-2.5">
              <Checkbox
                :model-value="fmtAnthropic"
                :disabled="fmtAnthropic && !fmtOpenai"
                aria-label="anthropic"
                @update:model-value="toggleFmt('anthropic')"
              />
              <span class="text-sm font-medium leading-none">anthropic</span>
              <span class="text-xs text-muted-foreground">/messages</span>
            </div>
          </div>
          <p class="text-xs text-muted-foreground">{{ t("sources.addHint") }}</p>
        </div>

        <div v-if="fmtOpenai" class="space-y-1.5">
          <Label for="s-url-openai">{{ t("sources.urlLabelOpenai") }}</Label>
          <Input id="s-url-openai" v-model="baseUrlOpenai" :placeholder="t('sources.urlPhOpenai')" autocomplete="off" aria-label="openai base url" />
          <p class="text-xs text-muted-foreground">{{ t("sources.urlHintOpenai") }}</p>
        </div>
        <div v-if="fmtAnthropic" class="space-y-1.5">
          <Label for="s-url-anthropic">{{ t("sources.urlLabelAnthropic") }}</Label>
          <Input id="s-url-anthropic" v-model="baseUrlAnthropic" :placeholder="t('sources.urlPhAnthropic')" autocomplete="off" aria-label="anthropic base url" />
          <p class="text-xs text-muted-foreground">{{ t("sources.urlHintAnthropic") }}</p>
        </div>

        <!-- why two base URLs: collapsible, lives next to the fields it explains -->
        <button
          type="button"
          class="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          @click="showBaseHelp = !showBaseHelp"
        >
          <Info class="h-3.5 w-3.5" />
          {{ t("sources.baseHelpToggle") }}
          <ChevronDown class="h-3.5 w-3.5 transition-transform" :class="{ 'rotate-180': showBaseHelp }" />
        </button>
        <div v-if="showBaseHelp" class="space-y-1.5 rounded-md border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
          <p>{{ t("sources.baseHelpSplit") }}</p>
          <p><span class="font-medium text-foreground">openai</span> — {{ t("sources.baseHelpOpenai") }}</p>
          <p><span class="font-medium text-foreground">anthropic</span> — {{ t("sources.baseHelpAnthropic") }}</p>
        </div>

        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <Label for="s-key">{{ t("sources.keyLabel") }}</Label>
            <span v-if="provider?.apiKey" class="text-xs text-muted-foreground">{{ t("sources.currentKeyLabel") }}: {{ provider.apiKey }}</span>
          </div>
          <Input
            id="s-key"
            v-model="apiKey"
            type="password"
            :placeholder="provider ? t('sources.keyPhEdit') : t('sources.keyPh')"
            autocomplete="new-password"
            aria-label="api key"
          />
        </div>

        <div class="space-y-1.5">
          <Label for="s-rpm">{{ t("sources.rpmLabel") }}</Label>
          <Input id="s-rpm" v-model="rpm" type="number" min="0" inputmode="numeric" :placeholder="t('sources.rpmPh')" aria-label="rpm" />
          <p class="text-xs text-muted-foreground">{{ t("sources.rpmHint") }}</p>
        </div>

        <p v-if="err" class="text-sm text-destructive">{{ err }}</p>
      </div>

      <div class="flex shrink-0 justify-end gap-2">
        <Button variant="outline" :disabled="saving" @click="open = false">{{ t("common.cancel") }}</Button>
        <Button :disabled="saving" @click="save">
          <Loader2 v-if="saving" class="h-4 w-4 animate-spin" />
          {{ t("sources.saveBtn") }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
