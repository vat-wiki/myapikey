<script setup lang="ts">
import { ref, onMounted } from "vue";
import { getCreds, setCreds, clearCreds, req } from "./api";
import Providers from "./Providers.vue";
import Models from "./Models.vue";
import Logs from "./Logs.vue";

const authed = ref(false);
const tab = ref<"providers" | "models" | "logs">("providers");
const user = ref("");
const pass = ref("");
const loginErr = ref("");
const checking = ref(true);

async function tryLogin() {
  loginErr.value = "";
  setCreds(user.value, pass.value);
  try {
    await req("GET", "/admin/providers");
    authed.value = true;
  } catch (e) {
    loginErr.value = (e as Error).message;
    clearCreds();
  }
}

function logout() {
  clearCreds();
  authed.value = false;
  user.value = "";
  pass.value = "";
}

onMounted(async () => {
  if (getCreds()) {
    try {
      await req("GET", "/admin/providers");
      authed.value = true;
      const c = getCreds()!;
      user.value = c.user;
    } catch {
      clearCreds();
    }
  }
  checking.value = false;
});
</script>

<template>
  <div v-if="checking" class="container muted">Connecting…</div>

  <div v-else-if="!authed" class="login card">
    <h2>my-ai-gate</h2>
    <p class="muted" style="text-align: center; margin-top: -4px">Sign in to manage your gateway</p>
    <form @submit.prevent="tryLogin">
      <div class="field">
        <label>Username</label>
        <input v-model="user" autocomplete="username" autofocus />
      </div>
      <div class="field">
        <label>Password</label>
        <input v-model="pass" type="password" autocomplete="current-password" />
      </div>
      <button class="primary" type="submit">Sign in</button>
      <div v-if="loginErr" class="error">{{ loginErr }}</div>
    </form>
  </div>

  <div v-else>
    <div class="header">
      <h1>my-ai-gate <span class="dot">●</span></h1>
      <button @click="logout">Sign out</button>
    </div>
    <div class="tabs">
      <button :class="{ active: tab === 'providers' }" @click="tab = 'providers'">Providers</button>
      <button :class="{ active: tab === 'models' }" @click="tab = 'models'">Models</button>
      <button :class="{ active: tab === 'logs' }" @click="tab = 'logs'">Recent calls</button>
    </div>
    <div class="container">
      <Providers v-if="tab === 'providers'" />
      <Models v-else-if="tab === 'models'" />
      <Logs v-else />
    </div>
  </div>
</template>
