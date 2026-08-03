<script setup lang="ts">
import { ref, onMounted } from "vue";
import { req, type ProviderPublic } from "./api";

const providers = ref<ProviderPublic[]>([]);
const loading = ref(false);
const err = ref("");

const newName = ref("");
const newBaseUrl = ref("");
const newKey = ref("");
const fmtOpenai = ref(true);
const fmtAnthropic = ref(false);

// discovery UI state per provider
const discovering = ref<Record<string, boolean>>({});
const discovered = ref<Record<string, string[]>>({});

async function load() {
  loading.value = true;
  try {
    const r = await req<{ providers: ProviderPublic[] }>("GET", "/admin/providers");
    providers.value = r.providers;
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function add() {
  err.value = "";
  const formats: string[] = [];
  if (fmtOpenai.value) formats.push("openai");
  if (fmtAnthropic.value) formats.push("anthropic");
  if (!formats.length) {
    err.value = "Pick at least one format";
    return;
  }
  try {
    await req("POST", "/admin/providers", {
      name: newName.value,
      baseUrl: newBaseUrl.value,
      apiKey: newKey.value,
      formats,
    });
    newName.value = newBaseUrl.value = newKey.value = "";
    await load();
  } catch (e) {
    err.value = (e as Error).message;
  }
}

async function remove(p: ProviderPublic) {
  if (!confirm(`Remove provider ${p.name}? It will be unlinked from all models.`)) return;
  await req("DELETE", `/admin/providers/${p.id}`);
  await load();
}

async function discover(p: ProviderPublic) {
  discovering.value[p.id] = true;
  discovered.value[p.id] = [];
  try {
    const r = await req<{ models: string[] }>("POST", `/admin/providers/${p.id}/discover`);
    discovered.value[p.id] = r.models;
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    discovering.value[p.id] = false;
  }
}

async function enable(model: string, providerId: string) {
  try {
    await req("POST", "/admin/models", { name: model, providerId });
    alert(`Enabled ${model}. Configure priority on the Models tab.`);
  } catch (e) {
    err.value = (e as Error).message;
  }
}

onMounted(load);
</script>

<template>
  <div class="card">
    <h3 style="margin-top: 0">Add a backend</h3>
    <p class="muted" style="margin-top: -6px">
      Base URL must include the <code>/v1</code> segment (e.g. <code>https://api.openai.com/v1</code>).
    </p>
    <div class="row" style="margin-bottom: 8px">
      <input v-model="newName" placeholder="name (e.g. openrouter)" style="width: 160px" />
      <input v-model="newBaseUrl" placeholder="https://…/v1" style="flex: 1; min-width: 220px" />
    </div>
    <div class="row" style="margin-bottom: 8px">
      <input v-model="newKey" placeholder="api key" type="password" style="flex: 1; min-width: 220px" />
    </div>
    <div class="row">
      <label class="row" style="gap: 4px"><input type="checkbox" v-model="fmtOpenai" /> openai</label>
      <label class="row" style="gap: 4px"><input type="checkbox" v-model="fmtAnthropic" /> anthropic</label>
      <button class="primary" @click="add">Add</button>
    </div>
    <div v-if="err" class="error">{{ err }}</div>
  </div>

  <div class="card">
    <h3 style="margin-top: 0">Backends</h3>
    <p v-if="loading" class="muted">Loading…</p>
    <p v-else-if="!providers.length" class="muted">No backends yet.</p>
    <table v-else>
      <thead>
        <tr><th>Name</th><th>Formats</th><th>Base URL</th><th>Key</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="p in providers" :key="p.id">
          <td><b>{{ p.name }}</b></td>
          <td>
            <span class="tag" v-for="f in p.formats" :key="f" style="margin-right: 4px">{{ f }}</span>
          </td>
          <td class="monos muted">{{ p.baseUrl }}</td>
          <td class="monos muted">{{ p.apiKey }}</td>
          <td>
            <div class="row" style="justify-content: flex-end">
              <button @click="discover(p)" :disabled="discovering[p.id]">Discover</button>
              <button class="danger" @click="remove(p)">Remove</button>
            </div>
            <div v-if="discovered[p.id]" style="margin-top: 8px">
              <div v-if="!discovered[p.id].length" class="muted">No models found.</div>
              <div v-else>
                <div v-for="m in discovered[p.id]" :key="m" class="row" style="padding: 3px 0">
                  <span class="monos">{{ m }}</span>
                  <button @click="enable(m, p.id)" style="margin-left: auto">Enable</button>
                </div>
              </div>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
