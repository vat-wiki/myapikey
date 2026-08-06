<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { req, setCreds, getCreds } from "@/api";
import { toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Copy, Check, Eye, EyeOff, Loader2, RotateCcw, User, KeyRound, HardDrive } from "lucide-vue-next";
import ConfirmDialog from "@/ConfirmDialog.vue";

const { t } = useI18n();

// --- account (web login) ---
const account = ref<{ username: string; password: string } | null>(null);
const username = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const showPass = ref(false);
const saving = ref(false);
const formErr = ref("");

// --- api key (agent calls /v1) ---
const apiKey = ref<string | null>(null);
const showKey = ref(false);
const rotating = ref(false);
const confirmOpen = ref(false);

// --- storage (read-only on-disk paths) ---
const storage = ref<{ dataDir: string; dataFile: string; logsFile: string } | null>(null);

const copied = ref("");
const loginPassword = computed(() => account.value?.password ?? "");
const storageRows = computed(() => {
  const s = storage.value;
  if (!s) return [];
  return [
    { key: "datadir", label: t("settings.storage.dataDir"), value: s.dataDir },
    { key: "datafile", label: t("settings.storage.dataFile"), value: s.dataFile },
    { key: "logsfile", label: t("settings.storage.logsFile"), value: s.logsFile },
  ];
});

async function load() {
  try {
    const [acct, key, st] = await Promise.all([
      req<{ username: string; password: string }>("GET", "/admin/account"),
      req<{ apiKey: string }>("GET", "/admin/api-key"),
      req<{ dataDir: string; dataFile: string; logsFile: string }>("GET", "/admin/storage"),
    ]);
    account.value = acct;
    username.value = acct.username;
    apiKey.value = key.apiKey;
    storage.value = st;
  } catch (e) {
    toast((e as Error).message, "error");
  }
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

function validateAccount(): string | null {
  if (!username.value.trim()) return t("settings.errUserShort");
  if (newPassword.value) {
    if (newPassword.value.length < 8) return t("settings.errPassShort");
    if (newPassword.value !== confirmPassword.value) return t("settings.errPassMismatch");
  }
  return null;
}

async function saveAccount() {
  if (saving.value) return;
  formErr.value = "";
  const err = validateAccount();
  if (err) {
    formErr.value = err;
    return;
  }
  saving.value = true;
  const body: { username: string; password?: string } = { username: username.value.trim() };
  if (newPassword.value) body.password = newPassword.value;
  try {
    await req("PUT", "/admin/account", body);
    // Refresh cached Basic-auth creds so the next request isn't 401'd.
    const pass = newPassword.value || account.value?.password || getCreds()?.pass || "";
    const user = username.value.trim();
    setCreds(user, pass);
    account.value = { username: user, password: pass };
    newPassword.value = "";
    confirmPassword.value = "";
    toast(t("settings.saved"), "success");
  } catch (e) {
    formErr.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

async function rotateKey() {
  if (rotating.value) return;
  rotating.value = true;
  try {
    const r = await req<{ apiKey: string }>("POST", "/admin/api-key/rotate");
    apiKey.value = r.apiKey;
    toast(t("settings.apikey.rotated"), "success");
    confirmOpen.value = false;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    rotating.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="max-w-xl space-y-4">
    <!-- Account (web login) -->
    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-base"><User class="h-4 w-4 text-primary" />{{ t("settings.title") }}</CardTitle>
        <CardDescription>{{ t("settings.desc") }}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <!-- Login password: read-only, reveal + copy -->
        <div class="space-y-1.5">
          <Label>{{ t("settings.loginPassword") }}</Label>
          <div class="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div class="min-w-0 truncate font-mono text-sm">
              {{ account ? (showPass ? loginPassword : "•".repeat(Math.min(loginPassword.length, 24))) : "…" }}
            </div>
            <div class="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                :title="showPass ? t('connect.hide') : t('connect.reveal')"
                :aria-label="showPass ? t('connect.hide') : t('connect.reveal')"
                @click="showPass = !showPass"
              >
                <EyeOff v-if="showPass" class="h-4 w-4" />
                <Eye v-else class="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" @click="copy('pass', loginPassword)">
                <Check v-if="copied === 'pass'" class="h-4 w-4" />
                <Copy v-else class="h-4 w-4" />
                {{ copied === "pass" ? t("connect.copied") : t("connect.copy") }}
              </Button>
            </div>
          </div>
        </div>

        <div class="space-y-3">
          <div class="space-y-1.5">
            <Label for="username">{{ t("settings.username") }}</Label>
            <Input id="username" v-model="username" autocomplete="username" />
          </div>
          <div class="space-y-1.5">
            <Label for="newpass">{{ t("settings.newPassword") }}</Label>
            <Input
              id="newpass"
              v-model="newPassword"
              type="password"
              :placeholder="t('settings.newPasswordPh')"
              autocomplete="new-password"
            />
          </div>
          <div class="space-y-1.5">
            <Label for="confirmpass">{{ t("settings.confirmPassword") }}</Label>
            <Input
              id="confirmpass"
              v-model="confirmPassword"
              type="password"
              :placeholder="t('settings.confirmPh')"
              autocomplete="new-password"
            />
          </div>

          <p v-if="formErr" class="text-sm text-destructive">{{ formErr }}</p>

          <div class="flex justify-end">
            <Button :disabled="saving" @click="saveAccount">
              <Loader2 v-if="saving" class="h-4 w-4 animate-spin" />
              {{ saving ? t("settings.saving") : t("settings.save") }}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- API Key (agent calls /v1) -->
    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-base"><KeyRound class="h-4 w-4 text-primary" />{{ t("settings.apikey.title") }}</CardTitle>
        <CardDescription>{{ t("settings.apikey.desc") }}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <div
          class="flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3"
        >
          <div class="min-w-0 truncate font-mono text-sm">
            {{ apiKey ? (showKey ? apiKey : "•".repeat(Math.min(apiKey.length, 24))) : "…" }}
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
            <Button variant="outline" size="sm" @click="copy('apikey', apiKey ?? '')">
              <Check v-if="copied === 'apikey'" class="h-4 w-4" />
              <Copy v-else class="h-4 w-4" />
              {{ copied === "apikey" ? t("connect.copied") : t("connect.copy") }}
            </Button>
          </div>
        </div>

        <div class="flex justify-end">
          <Button variant="outline" :disabled="rotating" @click="confirmOpen = true">
            <RotateCcw class="h-4 w-4" />
            {{ t("settings.apikey.rotate") }}
          </Button>
        </div>
      </CardContent>
    </Card>

    <!-- Storage (read-only on-disk paths) -->
    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-base"><HardDrive class="h-4 w-4 text-primary" />{{ t("settings.storage.title") }}</CardTitle>
        <CardDescription>{{ t("settings.storage.desc") }}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <div v-for="row in storageRows" :key="row.key" class="space-y-1.5">
          <Label>{{ row.label }}</Label>
          <div class="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div class="min-w-0 truncate font-mono text-sm">{{ row.value }}</div>
            <Button variant="outline" size="sm" @click="copy(row.key, row.value)">
              <Check v-if="copied === row.key" class="h-4 w-4" />
              <Copy v-else class="h-4 w-4" />
              {{ copied === row.key ? t("connect.copied") : t("connect.copy") }}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>

    <ConfirmDialog
      v-model:open="confirmOpen"
      variant="destructive"
      :title="t('settings.apikey.rotateTitle')"
      :description="t('settings.apikey.rotateDesc')"
      :confirm-text="t('settings.apikey.rotateConfirm')"
      :loading="rotating"
      @confirm="rotateKey"
    />
  </div>
</template>
