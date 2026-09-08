<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ModelView, type ProviderPublic } from "@/api";
import type { Fmt } from "@/lib/format";
import { FMT_ACCENT } from "@/lib/format";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Plus, Trash2, Loader2, Pencil, RefreshCw, ServerCog, MoreHorizontal } from "lucide-vue-next";
import ConfirmDialog from "@/ConfirmDialog.vue";
import SourceDialog from "@/SourceDialog.vue";

const { t } = useI18n();

const emit = defineEmits<{ goto: [string] }>();

const providers = ref<ProviderPublic[]>([]);
/** Whether at least one model exists — drives the "now create a model" nudge
 *  shown to someone who just finished the first-run source setup. */
const hasModels = ref(true);
const loading = ref(false);
const err = ref("");

// --- create / edit dialog ---

const dialogOpen = ref(false);
const editing = ref<ProviderPublic | null>(null);

function openCreate() {
  editing.value = null;
  dialogOpen.value = true;
}
function openEdit(p: ProviderPublic) {
  editing.value = p;
  dialogOpen.value = true;
}
/** Upsert from the dialog: replace the row on edit, append on create. */
function onSaved(p: ProviderPublic) {
  const exists = providers.value.some((x) => x.id === p.id);
  providers.value = exists
    ? providers.value.map((x) => (x.id === p.id ? p : x))
    : [...providers.value, p];
}

// --- discovery / delete ---

const refreshing = ref<Record<string, boolean>>({});

async function refresh(p: ProviderPublic) {
  refreshing.value[p.id] = true;
  try {
    const r = await req<{ models: string[] }>("POST", `/admin/providers/${p.id}/discover`);
    providers.value = providers.value.map((x) =>
      x.id === p.id ? { ...x, discoveredModels: r.models } : x,
    );
    toast(t("sources.refreshDone", { name: p.name }), r.models.length ? "success" : "default");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    refreshing.value[p.id] = false;
  }
}

const confirmTarget = ref<ProviderPublic | null>(null);
const confirmOpen = ref(false);
const removing = ref(false);

async function doRemove() {
  const p = confirmTarget.value;
  if (!p || removing.value) return;
  removing.value = true;
  try {
    await req("DELETE", `/admin/providers/${p.id}`);
    providers.value = providers.value.filter((x) => x.id !== p.id);
    toast(t("sources.removed", { name: p.name }), "success");
    confirmOpen.value = false;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    removing.value = false;
  }
}

// --- discovery badge state ---

function discCount(p: ProviderPublic): number {
  return p.discoveredModels?.length ?? 0;
}
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

function fmtBadgeClass(f: string): string {
  return f in FMT_ACCENT ? FMT_ACCENT[f as Fmt].badge : "";
}

async function load() {
  loading.value = true;
  err.value = "";
  try {
    const [pr, mr] = await Promise.all([
      req<{ providers: ProviderPublic[] }>("GET", "/admin/providers"),
      req<{ models: ModelView[] }>("GET", "/admin/models").catch(() => null),
    ]);
    providers.value = pr.providers;
    hasModels.value = !!mr?.models.length;
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-4">
    <!-- page header -->
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <ServerCog class="h-4 w-4 text-primary" />
        <span class="text-base font-semibold">{{ t("sources.pageTitle") }}</span>
        <span class="text-sm text-muted-foreground">{{ t("sources.pageDesc") }}</span>
      </div>
      <Button v-if="providers.length" size="sm" @click="openCreate">
        <Plus class="h-4 w-4" />{{ t("sources.add") }}
      </Button>
    </div>

    <p v-if="loading" class="py-8 text-center text-sm text-muted-foreground">{{ t("common.loading") }}</p>
    <p v-else-if="err" class="py-8 text-center text-sm text-destructive">{{ err }}</p>

    <!-- empty: add the first source -->
    <Card v-else-if="!providers.length">
      <CardContent class="flex flex-col items-center gap-3 py-12 text-center">
        <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <ServerCog class="h-5 w-5" />
        </span>
        <div class="space-y-1">
          <div class="font-medium">{{ t("sources.emptyTitle") }}</div>
          <p class="max-w-sm text-sm text-muted-foreground">{{ t("sources.emptyHint") }}</p>
        </div>
        <Button @click="openCreate">
          <Plus class="h-4 w-4" />{{ t("sources.add") }}
        </Button>
      </CardContent>
    </Card>

    <template v-else>
      <!-- first-run nudge: a source alone isn't callable — point at the next step -->
      <div v-if="!hasModels" class="flex flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2.5">
        <p class="min-w-0 flex-1 text-sm">{{ t("sources.nextHint") }}</p>
        <Button size="sm" @click="emit('goto', 'models')">{{ t("sources.nextCta") }}</Button>
      </div>

      <!-- source cards -->
      <div class="grid items-stretch gap-3 md:grid-cols-2">
        <Card
          v-for="p in providers"
          :key="p.id"
          class="group cursor-pointer gap-0 py-0 transition-colors hover:bg-muted/30"
          @click="openEdit(p)"
        >
          <div class="flex h-full flex-col gap-3 p-4">
            <!-- name + badges -->
            <div class="flex min-w-0 flex-wrap items-center gap-1.5">
              <span class="truncate text-sm font-semibold">{{ p.name }}</span>
              <Badge
                v-for="f in p.formats"
                :key="f"
                variant="outline"
                class="shrink-0"
                :class="fmtBadgeClass(f)"
              >{{ f }}</Badge>
              <Badge v-if="p.supportsResponses" variant="outline" class="shrink-0" :class="FMT_ACCENT.responses.badge">responses</Badge>
              <Badge v-if="p.rpm" variant="outline" class="shrink-0" :title="t('sources.rpmBadgeHint')">{{ t("sources.rpmBadge", { n: p.rpm }) }}</Badge>
              <Badge variant="muted" class="shrink-0" :title="discTitle(p)">{{ discLabel(p) }}</Badge>
            </div>

            <!-- base URLs, one line per enabled format -->
            <div class="min-w-0 flex-1 space-y-1">
              <div v-if="p.formats.includes('openai')" class="truncate font-mono text-xs text-muted-foreground">
                <span class="opacity-60">openai ·</span> {{ p.baseUrlOpenai }}
              </div>
              <div v-if="p.formats.includes('anthropic')" class="truncate font-mono text-xs text-muted-foreground">
                <span class="opacity-60">anthropic ·</span> {{ p.baseUrlAnthropic }}
              </div>
            </div>

            <!-- actions -->
            <div class="flex items-center gap-1 border-t pt-3" @click.stop>
              <Button variant="ghost" size="sm" class="h-7 gap-1.5 px-2 text-xs" :disabled="refreshing[p.id]" @click="refresh(p)">
                <Loader2 v-if="refreshing[p.id]" class="h-3.5 w-3.5 animate-spin" />
                <RefreshCw v-else class="h-3.5 w-3.5" />{{ t("sources.refreshModels") }}
              </Button>
              <Button variant="ghost" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="openEdit(p)">
                <Pencil class="h-3.5 w-3.5" />{{ t("sources.editLabel") }}
              </Button>
              <div class="ml-auto">
                <DropdownMenu>
                  <DropdownMenuTrigger>
                    <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground" :aria-label="t('sources.moreActions')">
                      <MoreHorizontal class="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem class="text-destructive focus:bg-destructive/10 focus:text-destructive" @select="confirmTarget = p; confirmOpen = true">
                      <Trash2 />
                      {{ t("sources.deleteLabel") }}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </template>

    <SourceDialog v-model:open="dialogOpen" :provider="editing" @saved="onSaved" />

    <ConfirmDialog
      v-model:open="confirmOpen"
      variant="destructive"
      :title="t('sources.remove')"
      :description="confirmTarget ? t('sources.confirmRemove', { name: confirmTarget.name }) : ''"
      :confirm-text="t('sources.remove')"
      :loading="removing"
      @confirm="doRemove"
    />
  </div>
</template>
