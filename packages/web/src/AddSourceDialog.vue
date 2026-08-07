<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ProviderPublic } from "@/api";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Plus, Loader2 } from "lucide-vue-next";

const { t } = useI18n();

const props = defineProps<{
  modelName: string;
  providers: ProviderPublic[];
  /** Routing slots this model is enabled on (the routes a source could join). */
  enabledFormats: string[];
  /** Current chain provider ids per routing slot, so we skip routes already served. */
  chainByFormat: Record<string, string[]>;
}>();
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ added: [] }>();

const enc = encodeURIComponent;

const selectedId = ref("");
const upstream = ref("");
const submitting = ref(false);

function supportsFmt(o: { formats: string[]; supportsResponses?: boolean }, f: string): boolean {
  return f === "responses" ? !!o.supportsResponses : o.formats.includes(f);
}

/** Routes the selected source would actually be added to (enabled, speaks, not in chain). */
function addTargets(pid: string): string[] {
  const p = props.providers.find((x) => x.id === pid);
  if (!p) return [];
  return props.enabledFormats.filter((f) => supportsFmt(p, f) && !(props.chainByFormat[f] ?? []).includes(pid));
}

/** Sources that can still attach to ≥1 enabled route of this model. */
const candidates = computed(() =>
  props.providers
    .filter((p) => props.enabledFormats.some((f) => supportsFmt(p, f) && !(props.chainByFormat[f] ?? []).includes(p.id)))
    .sort((a, b) => a.name.localeCompare(b.name)),
);

const SHORT: Record<string, string> = {
  openai: "models.fmtOpenaiShort",
  anthropic: "models.fmtAnthropicShort",
  responses: "models.fmtResponsesShort",
};
/** Human labels for the routes the selected source will join, shown under the select. */
const targetsPreview = computed(() => (selectedId.value ? addTargets(selectedId.value).map((f) => t(SHORT[f] ?? f)) : []));

const canSubmit = computed(() => !!selectedId.value && !submitting.value);

watch(open, (o) => {
  if (!o) return;
  selectedId.value = candidates.value[0]?.id ?? "";
  upstream.value = "";
});

/** Attach the source to every route it speaks but isn't on yet (one POST each);
 *  if an upstream name was given, set that mapping on every enabled route it speaks. */
async function submit() {
  if (!canSubmit.value) return;
  const pid = selectedId.value;
  const p = props.providers.find((x) => x.id === pid);
  if (!pid || !p) return;
  const addTgts = addTargets(pid);
  const up = upstream.value.trim();
  submitting.value = true;
  try {
    const addResults = await Promise.allSettled(
      addTgts.map((f) => req("POST", `/admin/models/${enc(props.modelName)}/providers`, { format: f, providerId: pid })),
    );
    let fail = addResults.filter((r) => r.status === "rejected").length;
    if (up) {
      const mapTgts = props.enabledFormats.filter((f) => supportsFmt(p, f));
      const mapResults = await Promise.allSettled(
        mapTgts.map((f) => req("PUT", `/admin/models/${enc(props.modelName)}/map`, { format: f, providerId: pid, model: up })),
      );
      fail += mapResults.filter((r) => r.status === "rejected").length;
    }
    if (!fail) toast(t("models.sourceAdded"), "success");
    else toast(t("models.addSourcePartial"), "error");
    emit("added");
    open.value = false;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-md">
      <div class="flex items-center gap-2 pr-8">
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
          <Plus class="h-4 w-4" />
        </span>
        <div class="min-w-0">
          <DialogTitle class="text-base">{{ t("models.addSourceTitle") }}</DialogTitle>
          <DialogDescription>{{ t("models.addSourceDesc") }}</DialogDescription>
        </div>
      </div>

      <div class="space-y-3">
        <div v-if="!candidates.length" class="rounded-md bg-muted/40 px-3 py-6 text-center text-sm text-muted-foreground">
          {{ t("models.addSourceNone") }}
        </div>
        <template v-else>
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground">{{ t("models.providerLabel") }}</label>
            <Select v-model="selectedId">
              <SelectTrigger>
                <SelectValue :placeholder="t('models.providerPh')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="p in candidates" :key="p.id" :value="p.id">{{ p.name }}</SelectItem>
              </SelectContent>
            </Select>
            <p v-if="targetsPreview.length" class="text-xs text-muted-foreground">
              {{ t("models.addSourceTargetsHint") }} <span class="font-medium text-foreground">{{ targetsPreview.join(" / ") }}</span>
            </p>
          </div>

          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground">{{ t("models.upstreamLabel") }}</label>
            <input
              v-model="upstream"
              type="text"
              :placeholder="t('models.upstreamPh')"
              :title="t('models.upstreamHint')"
              spellcheck="false"
              class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono text-sm shadow-sm transition-colors placeholder:font-sans placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            />
            <p class="text-xs text-muted-foreground">{{ t("models.upstreamHint") }}</p>
          </div>
        </template>

        <div class="flex justify-end gap-2">
          <Button variant="outline" :disabled="submitting" @click="open = false">
            {{ t("common.cancel") }}
          </Button>
          <Button :disabled="!canSubmit || !candidates.length" @click="submit">
            <Loader2 v-if="submitting" class="h-4 w-4 animate-spin" />
            <Plus v-else class="h-4 w-4" />
            {{ t("models.addToChain") }}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
