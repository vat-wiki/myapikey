<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ProviderPublic } from "@/api";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Plus, Trash2, Loader2, Pencil, RefreshCw, ServerCog, MoreHorizontal, Info, ChevronDown } from "lucide-vue-next";
import ConfirmDialog from "@/ConfirmDialog.vue";

const { t } = useI18n();

const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ changed: [] }>();

const providers = ref<ProviderPublic[]>([]);
const loading = ref(false);
const err = ref("");

// --- add form ---
const newName = ref("");
const newBaseUrlOpenai = ref("");
const newBaseUrlAnthropic = ref("");
const newKey = ref("");
const newRpm = ref("");
const fmtOpenai = ref(true);
const fmtAnthropic = ref(false);
const newResponses = ref(false);
const adding = ref(false);
const formErr = ref("");
const showAdd = ref(false);
const showBaseHelp = ref(false);

// --- edit state (inline on a card) ---
const editingId = ref<string | null>(null);
const editName = ref("");
const editBaseUrlOpenai = ref("");
const editBaseUrlAnthropic = ref("");
const editKey = ref("");
const editRpm = ref("");
const editFmtOpenai = ref(true);
const editFmtAnthropic = ref(false);
const editResponses = ref(false);
const saving = ref(false);

const refreshing = ref<Record<string, boolean>>({});

const confirmTarget = ref<ProviderPublic | null>(null);
const confirmOpen = ref(false);
const removing = ref(false);

async function load() {
  loading.value = true;
  err.value = "";
  try {
    const r = await req<{ providers: ProviderPublic[] }>("GET", "/admin/providers");
    providers.value = r.providers;
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

watch(open, (o) => {
  if (o) load();
});

/** Toggle a format button, but never let both be turned off. */
function toggleFmt(scope: "new" | "edit", which: "openai" | "anthropic") {
  const o = scope === "new" ? fmtOpenai : editFmtOpenai;
  const a = scope === "new" ? fmtAnthropic : editFmtAnthropic;
  if (which === "openai") {
    if (o.value && !a.value) return;
    o.value = !o.value;
  } else {
    if (a.value && !o.value) return;
    a.value = !a.value;
  }
}

function pickedFormats(scope: "new" | "edit"): string[] {
  const out: string[] = [];
  if ((scope === "new" ? fmtOpenai : editFmtOpenai).value) out.push("openai");
  if ((scope === "new" ? fmtAnthropic : editFmtAnthropic).value) out.push("anthropic");
  return out;
}

async function add() {
  if (adding.value) return;
  formErr.value = "";
  const formats = pickedFormats("new");
  if (!newName.value || !newKey.value) {
    formErr.value = t("sources.errRequired");
    return;
  }
  if (!formats.length) {
    formErr.value = t("sources.errFormat");
    return;
  }
  if ((fmtOpenai.value && !newBaseUrlOpenai.value) || (fmtAnthropic.value && !newBaseUrlAnthropic.value)) {
    formErr.value = t("sources.errBaseUrl");
    return;
  }
  adding.value = true;
  try {
    const r = await req<{ provider: ProviderPublic }>("POST", "/admin/providers", {
      name: newName.value,
      baseUrlOpenai: newBaseUrlOpenai.value,
      baseUrlAnthropic: newBaseUrlAnthropic.value,
      apiKey: newKey.value,
      formats,
      supportsResponses: fmtOpenai.value && newResponses.value,
      rpm: Number(newRpm.value) || 0,
    });
    providers.value = [...providers.value, r.provider];
    newName.value = newKey.value = "";
    newBaseUrlOpenai.value = newBaseUrlAnthropic.value = "";
    newRpm.value = "";
    newResponses.value = false;
    showAdd.value = false;
    toast(t("sources.added"), "success");
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    adding.value = false;
  }
}

function startEdit(p: ProviderPublic) {
  editingId.value = p.id;
  editName.value = p.name;
  editBaseUrlOpenai.value = p.baseUrlOpenai;
  editBaseUrlAnthropic.value = p.baseUrlAnthropic;
  editKey.value = ""; // blank = keep current (we only hold the masked key)
  editRpm.value = p.rpm ? String(p.rpm) : "";
  editFmtOpenai.value = p.formats.includes("openai");
  editFmtAnthropic.value = p.formats.includes("anthropic");
  editResponses.value = !!p.supportsResponses;
}
function cancelEdit() {
  editingId.value = null;
}

async function saveEdit(p: ProviderPublic) {
  if (saving.value) return;
  const formats = pickedFormats("edit");
  if (!editName.value) {
    toast(t("sources.errRequired"), "error");
    return;
  }
  if (!formats.length) {
    toast(t("sources.errFormat"), "error");
    return;
  }
  if ((editFmtOpenai.value && !editBaseUrlOpenai.value) || (editFmtAnthropic.value && !editBaseUrlAnthropic.value)) {
    toast(t("sources.errBaseUrl"), "error");
    return;
  }
  saving.value = true;
  try {
    const body: Record<string, unknown> = {
      name: editName.value,
      baseUrlOpenai: editBaseUrlOpenai.value,
      baseUrlAnthropic: editBaseUrlAnthropic.value,
      formats,
      supportsResponses: editFmtOpenai.value && editResponses.value,
      rpm: Number(editRpm.value) || 0,
    };
    if (editKey.value) body.apiKey = editKey.value; // omit → server keeps existing
    const r = await req<{ provider: ProviderPublic }>("PUT", `/admin/providers/${p.id}`, body);
    providers.value = providers.value.map((x) => (x.id === p.id ? r.provider : x));
    editingId.value = null;
    toast(t("sources.updated"), "success");
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    saving.value = false;
  }
}

async function refresh(p: ProviderPublic) {
  refreshing.value[p.id] = true;
  try {
    const r = await req<{ models: string[] }>("POST", `/admin/providers/${p.id}/discover`);
    providers.value = providers.value.map((x) =>
      x.id === p.id ? { ...x, discoveredModels: r.models } : x,
    );
    toast(t("sources.refreshDone", { name: p.name }), r.models.length ? "success" : "default");
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    refreshing.value[p.id] = false;
  }
}

function askRemove(p: ProviderPublic) {
  confirmTarget.value = p;
  confirmOpen.value = true;
}

async function doRemove() {
  const p = confirmTarget.value;
  if (!p || removing.value) return;
  removing.value = true;
  try {
    await req("DELETE", `/admin/providers/${p.id}`);
    providers.value = providers.value.filter((x) => x.id !== p.id);
    toast(t("sources.removed", { name: p.name }), "success");
    emit("changed");
    confirmOpen.value = false;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    removing.value = false;
  }
}

function discCount(p: ProviderPublic): number {
  return p.discoveredModels?.length ?? 0;
}
/** Discovery state for the source badge. Distinguishing "empty" from "never"
 *  matters: a source with no /models endpoint (e.g. Ark's coding-plan surface)
 *  is always empty after a scan, so labeling that "Not scanned" is misleading. */
function discState(p: ProviderPublic): "never" | "empty" | "found" {
  if (discCount(p) > 0) return "found";
  return p.discoveredAt ? "empty" : "never";
}
function discLabel(p: ProviderPublic): string {
  const s = discState(p);
  if (s === "found") return t("sources.discoveredCount", { n: discCount(p) });
  if (s === "empty") return t("sources.noModelsFound");
  return t("sources.notScanned");
}
function discTitle(p: ProviderPublic): string {
  const s = discState(p);
  if (s === "empty") return t("sources.noModelsHint");
  if (s === "never") return t("sources.notScannedHint");
  return "";
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-xl">
      <div class="flex items-center gap-2 pr-8">
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
          <ServerCog class="h-4 w-4" />
        </span>
        <div class="min-w-0">
          <DialogTitle class="text-base">{{ t("sources.manage") }}</DialogTitle>
          <DialogDescription>{{ t("sources.subtitle") }}</DialogDescription>
        </div>
      </div>

      <p v-if="loading" class="py-4 text-center text-sm text-muted-foreground">{{ t("common.loading") }}</p>
      <p v-else-if="err" class="py-4 text-center text-sm text-destructive">{{ err }}</p>

      <!-- Why per-format bases? Collapsed by default so it doesn't crowd the form. -->
      <div class="space-y-1">
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
      </div>

      <!-- Add: a collapsed button, or the form when opened / when there are no sources yet -->
      <Button
        v-if="!showAdd && providers.length"
        variant="outline"
        class="w-full justify-center"
        @click="showAdd = true"
      >
        <Plus class="h-4 w-4" />{{ t("sources.add") }}
      </Button>
      <div v-else class="space-y-3 rounded-lg border bg-muted/30 p-4">
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("sources.nameLabel") }}</label>
          <Input v-model="newName" :placeholder="t('sources.namePh')" autocomplete="off" aria-label="name" />
        </div>
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("sources.formats") }}</label>
          <div class="space-y-3 rounded-md border bg-background/50 p-3">
            <div class="space-y-2">
              <div class="flex items-center gap-2.5">
                <Checkbox
                  :model-value="fmtOpenai"
                  :disabled="fmtOpenai && !fmtAnthropic"
                  aria-label="openai"
                  @update:model-value="toggleFmt('new', 'openai')"
                />
                <span class="text-sm font-medium leading-none">openai</span>
                <span class="text-xs text-muted-foreground">/chat/completions</span>
              </div>
              <div class="flex items-center gap-2.5 pl-7">
                <Checkbox v-model="newResponses" :disabled="!fmtOpenai" :aria-label="t('sources.responses')" />
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
                @update:model-value="toggleFmt('new', 'anthropic')"
              />
              <span class="text-sm font-medium leading-none">anthropic</span>
              <span class="text-xs text-muted-foreground">/messages</span>
            </div>
          </div>
          <p class="text-xs text-muted-foreground">{{ t("sources.addHint") }}</p>
        </div>
        <div v-if="fmtOpenai" class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("sources.urlLabelOpenai") }}</label>
          <Input v-model="newBaseUrlOpenai" :placeholder="t('sources.urlPhOpenai')" autocomplete="off" aria-label="openai base url" />
          <p class="text-xs text-muted-foreground">{{ t("sources.urlHintOpenai") }}</p>
        </div>
        <div v-if="fmtAnthropic" class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("sources.urlLabelAnthropic") }}</label>
          <Input v-model="newBaseUrlAnthropic" :placeholder="t('sources.urlPhAnthropic')" autocomplete="off" aria-label="anthropic base url" />
          <p class="text-xs text-muted-foreground">{{ t("sources.urlHintAnthropic") }}</p>
        </div>
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("sources.keyLabel") }}</label>
          <Input v-model="newKey" type="password" :placeholder="t('sources.keyPh')" autocomplete="new-password" aria-label="api key" />
        </div>
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("sources.rpmLabel") }}</label>
          <Input v-model="newRpm" type="number" min="0" inputmode="numeric" :placeholder="t('sources.rpmPh')" aria-label="rpm" />
          <p class="text-xs text-muted-foreground">{{ t("sources.rpmHint") }}</p>
        </div>
        <p v-if="formErr" class="text-sm text-destructive">{{ formErr }}</p>
        <div class="flex justify-end gap-2">
          <Button v-if="providers.length" variant="ghost" size="sm" @click="showAdd = false">{{ t("sources.cancel") }}</Button>
          <Button size="sm" :disabled="adding" @click="add">
            <Loader2 v-if="adding" class="h-4 w-4 animate-spin" />
            <Plus v-else class="h-4 w-4" />{{ t("sources.addBtn") }}
          </Button>
        </div>
      </div>

      <!-- Source list (compact rows) -->
      <div v-if="providers.length" class="space-y-2">
        <div
          v-for="p in providers"
          :key="p.id"
          class="rounded-lg border p-3"
        >
          <!-- read-only -->
          <div v-if="editingId !== p.id" class="flex items-center gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate font-medium">{{ p.name }}</span>
                <Badge v-for="f in p.formats" :key="f" variant="secondary">{{ f }}</Badge>
                <Badge v-if="p.rpm" variant="outline" :title="t('sources.rpmBadgeHint')">{{ t("sources.rpmBadge", { n: p.rpm }) }}</Badge>
                <Badge variant="muted" :title="discTitle(p)">{{ discLabel(p) }}</Badge>
              </div>
              <div v-if="p.formats.includes('openai')" class="mt-0.5 truncate font-mono text-xs text-muted-foreground"><span class="opacity-60">openai ·</span> {{ p.baseUrlOpenai }}</div>
              <div v-if="p.formats.includes('anthropic')" class="mt-0.5 truncate font-mono text-xs text-muted-foreground"><span class="opacity-60">anthropic ·</span> {{ p.baseUrlAnthropic }}</div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger>
                <Button variant="ghost" size="icon" class="h-8 w-8" :aria-label="t('sources.moreActions')">
                  <MoreHorizontal class="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem :disabled="refreshing[p.id]" @select="refresh(p)">
                  <Loader2 v-if="refreshing[p.id]" class="animate-spin" />
                  <RefreshCw v-else />
                  {{ t("sources.refreshModels") }}
                </DropdownMenuItem>
                <DropdownMenuItem @select="startEdit(p)">
                  <Pencil />
                  {{ t("sources.editLabel") }}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem class="text-destructive focus:bg-destructive/10 focus:text-destructive" @select="askRemove(p)">
                  <Trash2 />
                  {{ t("sources.deleteLabel") }}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <!-- inline edit -->
          <div v-else class="space-y-3">
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ t("sources.nameLabel") }}</label>
              <Input v-model="editName" :placeholder="t('sources.namePh')" autocomplete="off" aria-label="name" />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ t("sources.formats") }}</label>
              <div class="space-y-3 rounded-md border bg-background/50 p-3">
                <div class="space-y-2">
                  <div class="flex items-center gap-2.5">
                    <Checkbox
                      :model-value="editFmtOpenai"
                      :disabled="editFmtOpenai && !editFmtAnthropic"
                      aria-label="openai"
                      @update:model-value="toggleFmt('edit', 'openai')"
                    />
                    <span class="text-sm font-medium leading-none">openai</span>
                    <span class="text-xs text-muted-foreground">/chat/completions</span>
                  </div>
                  <div class="flex items-center gap-2.5 pl-7">
                    <Checkbox v-model="editResponses" :disabled="!editFmtOpenai" :aria-label="t('sources.responses')" />
                    <span class="text-sm leading-none" :class="editFmtOpenai ? '' : 'text-muted-foreground'">{{ t("sources.responses") }}</span>
                    <span class="text-xs text-muted-foreground">/responses</span>
                  </div>
                </div>
                <Separator />
                <div class="flex items-center gap-2.5">
                  <Checkbox
                    :model-value="editFmtAnthropic"
                    :disabled="editFmtAnthropic && !editFmtOpenai"
                    aria-label="anthropic"
                    @update:model-value="toggleFmt('edit', 'anthropic')"
                  />
                  <span class="text-sm font-medium leading-none">anthropic</span>
                  <span class="text-xs text-muted-foreground">/messages</span>
                </div>
              </div>
            </div>
            <div v-if="editFmtOpenai" class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ t("sources.urlLabelOpenai") }}</label>
              <Input v-model="editBaseUrlOpenai" :placeholder="t('sources.urlPhOpenai')" autocomplete="off" aria-label="openai base url" />
              <p class="text-xs text-muted-foreground">{{ t("sources.urlHintOpenai") }}</p>
            </div>
            <div v-if="editFmtAnthropic" class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ t("sources.urlLabelAnthropic") }}</label>
              <Input v-model="editBaseUrlAnthropic" :placeholder="t('sources.urlPhAnthropic')" autocomplete="off" aria-label="anthropic base url" />
              <p class="text-xs text-muted-foreground">{{ t("sources.urlHintAnthropic") }}</p>
            </div>
            <div class="space-y-1.5">
              <div class="flex items-center justify-between">
                <label class="text-xs font-medium text-muted-foreground">{{ t("sources.keyLabel") }}</label>
                <span v-if="p.apiKey" class="text-xs text-muted-foreground">{{ t("sources.currentKeyLabel") }}: {{ p.apiKey }}</span>
              </div>
              <Input v-model="editKey" type="password" :placeholder="t('sources.keyPhEdit')" autocomplete="new-password" aria-label="api key" />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ t("sources.rpmLabel") }}</label>
              <Input v-model="editRpm" type="number" min="0" inputmode="numeric" :placeholder="t('sources.rpmPh')" aria-label="rpm" />
              <p class="text-xs text-muted-foreground">{{ t("sources.rpmHint") }}</p>
            </div>
            <div class="flex justify-end gap-2">
              <Button variant="ghost" size="sm" @click="cancelEdit">{{ t("sources.cancel") }}</Button>
              <Button size="sm" :disabled="saving" @click="saveEdit(p)">
                <Loader2 v-if="saving" class="h-4 w-4 animate-spin" />{{ t("sources.saveBtn") }}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>

  <ConfirmDialog
    v-model:open="confirmOpen"
    variant="destructive"
    :title="t('sources.remove')"
    :description="confirmTarget ? t('sources.confirmRemove', { name: confirmTarget.name }) : ''"
    :confirm-text="t('sources.remove')"
    :loading="removing"
    @confirm="doRemove"
  />
</template>
