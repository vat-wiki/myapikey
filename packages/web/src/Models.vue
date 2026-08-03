<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { req, type ModelView, type ProviderPublic } from "./api";

const models = ref<ModelView[]>([]);
const providers = ref<ProviderPublic[]>([]);
const err = ref("");
const loading = ref(false);
// selected provider to add, per model name
const addSel = ref<Record<string, string>>({});

async function load() {
  loading.value = true;
  try {
    const [m, p] = await Promise.all([
      req<{ models: ModelView[] }>("GET", "/admin/models"),
      req<{ providers: ProviderPublic[] }>("GET", "/admin/providers"),
    ]);
    models.value = m.models;
    providers.value = p.providers;
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function toggle(m: ModelView) {
  try {
    if (m.enabled) await req("POST", `/admin/models/${encodeURIComponent(m.name)}/disable`);
    else await req("POST", "/admin/models", { name: m.name });
    await load();
  } catch (e) {
    err.value = (e as Error).message;
  }
}

async function removeModel(m: ModelView) {
  if (!confirm(`Remove ${m.name} entirely?`)) return;
  await req("DELETE", `/admin/models/${encodeURIComponent(m.name)}`);
  await load();
}

async function setPriority(m: ModelView, ids: string[]) {
  try {
    await req("PUT", `/admin/models/${encodeURIComponent(m.name)}/priority`, { providers: ids });
    await load();
  } catch (e) {
    err.value = (e as Error).message;
  }
}
function moveUp(m: ModelView, i: number) {
  if (i === 0) return;
  const ids = m.providers.map((p) => p.id);
  [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
  setPriority(m, ids);
}
function moveDown(m: ModelView, i: number) {
  const ids = m.providers.map((p) => p.id);
  if (i >= ids.length - 1) return;
  [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
  setPriority(m, ids);
}

async function removeProvider(m: ModelView, pid: string) {
  await req("DELETE", `/admin/models/${encodeURIComponent(m.name)}/providers/${pid}`);
  await load();
}

async function addProvider(m: ModelView) {
  const pid = addSel.value[m.name];
  if (!pid) return;
  await req("POST", `/admin/models/${encodeURIComponent(m.name)}/providers`, { providerId: pid });
  addSel.value[m.name] = "";
  await load();
}

const availableToAdd = (m: ModelView) => providers.value.filter((p) => !m.providers.find((x) => x.id === p.id));

const sorted = computed(() =>
  [...models.value].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)),
);

onMounted(load);
</script>

<template>
  <div class="card">
    <h3 style="margin-top: 0">Routing table</h3>
    <p class="muted" style="margin-top: -6px">
      Enable models from the <b>Providers</b> tab (Discover). Here you set each model's provider priority —
      requests go to the first, falling over to the next on 429/5xx/timeout.
    </p>
    <p v-if="loading" class="muted">Loading…</p>
    <p v-else-if="!models.length" class="muted">No models yet. Discover some from the Providers tab.</p>
    <div v-for="m in sorted" :key="m.name" class="card" style="background: var(--panel-2)">
      <div class="row" style="justify-content: space-between">
        <div class="row">
          <b class="monos">{{ m.name }}</b>
          <span :class="m.enabled ? 'pill-ok' : 'pill-off'">{{ m.enabled ? "enabled" : "disabled" }}</span>
        </div>
        <div class="row">
          <button @click="toggle(m)">{{ m.enabled ? "Disable" : "Enable" }}</button>
          <button class="danger" @click="removeModel(m)">Remove</button>
        </div>
      </div>

      <div style="margin-top: 10px">
        <div v-if="!m.providers.length" class="muted">No providers. Add one below.</div>
        <div v-for="(p, i) in m.providers" :key="p.id" class="row" style="padding: 4px 0">
          <span class="muted" style="width: 18px">{{ i + 1 }}.</span>
          <span>{{ p.name }}</span>
          <span v-if="i === 0" class="tag">primary</span>
          <span v-else class="tag">fallback</span>
          <div class="row" style="margin-left: auto">
            <button @click="moveUp(m, i)" :disabled="i === 0">↑</button>
            <button @click="moveDown(m, i)" :disabled="i === m.providers.length - 1">↓</button>
            <button class="danger" @click="removeProvider(m, p.id)">✕</button>
          </div>
        </div>

        <div v-if="availableToAdd(m).length" class="row" style="margin-top: 8px">
          <select v-model="addSel[m.name]">
            <option value="" disabled>add provider…</option>
            <option v-for="p in availableToAdd(m)" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <button @click="addProvider(m)">Add</button>
        </div>
      </div>
    </div>
    <div v-if="err" class="error">{{ err }}</div>
  </div>
</template>
