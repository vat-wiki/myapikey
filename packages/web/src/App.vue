<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { getCreds, setCreds, clearCreds, req } from "@/api";
import { setLocale } from "@/i18n";
import Models from "@/Models.vue";
import Logs from "@/Logs.vue";
import Stats from "@/Stats.vue";
import Connect from "@/Connect.vue";
import Settings from "@/Settings.vue";
import Logo from "@/Logo.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Sun, Moon, LogOut, Cpu, Activity, BarChart3, Languages, Plug, Loader2, Eye, EyeOff, Settings as SettingsIcon } from "lucide-vue-next";
import Toaster from "@/components/ui/toast/Toaster.vue";

const { t, locale } = useI18n();

const authed = ref(false);
const user = ref("");
const pass = ref("");
const loginErr = ref("");
const checking = ref(true);
const submitting = ref(false);
const showPass = ref(false);
const dark = ref(true);

function applyTheme(isDark: boolean) {
  dark.value = isDark;
  document.documentElement.classList.toggle("dark", isDark);
  localStorage.setItem("myapikey.theme", isDark ? "dark" : "light");
}
function toggleTheme() {
  applyTheme(!dark.value);
}
function toggleLocale() {
  setLocale(locale.value === "zh" ? "en" : "zh");
}
const localeLabel = computed(() => (locale.value === "zh" ? "English" : "中文"));

async function tryLogin() {
  if (submitting.value) return;
  loginErr.value = "";
  submitting.value = true;
  // Store tentatively so req() can send Basic auth; cleared on failure.
  setCreds(user.value, pass.value);
  try {
    await req("GET", "/admin/providers");
    authed.value = true;
  } catch (e) {
    const msg = (e as Error).message;
    loginErr.value = /fetch|network/i.test(msg)
      ? t("login.errNetwork")
      : t("login.errInvalid");
    clearCreds();
  } finally {
    submitting.value = false;
  }
}
function logout() {
  clearCreds();
  authed.value = false;
  user.value = "";
  pass.value = "";
}

onMounted(async () => {
  const stored = localStorage.getItem("myapikey.theme");
  applyTheme(stored ? stored === "dark" : true);
  if (getCreds()) {
    try {
      await req("GET", "/admin/providers");
      authed.value = true;
      user.value = getCreds()!.user;
    } catch {
      clearCreds();
    }
  }
  checking.value = false;
});
</script>

<template>
  <div v-if="checking" class="flex min-h-screen items-center justify-center text-muted-foreground">
    {{ t("app.connecting") }}
  </div>

  <div v-else-if="!authed" class="flex min-h-screen items-center justify-center p-4">
    <Card class="w-full max-w-sm">
      <CardHeader class="space-y-3 text-center">
        <Logo :size="44" class="mx-auto" />
        <CardTitle class="text-xl">MyAPIKey</CardTitle>
        <CardDescription>{{ t("login.subtitle") }}</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="space-y-3" @submit.prevent="tryLogin">
          <div class="space-y-1.5">
            <Label for="u">{{ t("login.username") }}</Label>
            <Input id="u" v-model="user" autocomplete="username" autofocus />
          </div>
          <div class="space-y-1.5">
            <Label for="p">{{ t("login.password") }}</Label>
            <div class="relative">
              <Input
                id="p"
                v-model="pass"
                :type="showPass ? 'text' : 'password'"
                autocomplete="current-password"
                class="pr-9"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                class="absolute right-1 top-1 h-7 w-7 text-muted-foreground"
                :title="showPass ? t('connect.hide') : t('connect.reveal')"
                :aria-label="showPass ? t('connect.hide') : t('connect.reveal')"
                tabindex="-1"
                @click="showPass = !showPass"
              >
                <EyeOff v-if="showPass" class="h-4 w-4" />
                <Eye v-else class="h-4 w-4" />
              </Button>
            </div>
          </div>
          <Button type="submit" class="w-full" :disabled="submitting">
            <Loader2 v-if="submitting" class="h-4 w-4 animate-spin" />
            {{ submitting ? t("common.loading") : t("login.signIn") }}
          </Button>
          <p v-if="loginErr" class="text-sm text-destructive">{{ loginErr }}</p>
        </form>
      </CardContent>
    </Card>
  </div>

  <div v-else class="min-h-screen">
    <header class="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
      <div class="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <div class="flex items-center gap-2 font-semibold tracking-tight">
          <Logo :size="26" />
          MyAPIKey
        </div>
        <div class="flex items-center gap-1">
          <Button variant="ghost" size="sm" :title="localeLabel" @click="toggleLocale">
            <Languages class="h-4 w-4" />{{ localeLabel }}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            :title="dark ? t('app.toLight') : t('app.toDark')"
            @click="toggleTheme"
          >
            <Sun v-if="dark" class="h-4 w-4" />
            <Moon v-else class="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" @click="logout">
            <LogOut class="h-4 w-4" />{{ t("app.signOut") }}
          </Button>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-5xl px-4 py-6">
      <Tabs default-value="connect">
        <TabsList class="mb-2">
          <TabsTrigger value="connect"><Plug class="h-4 w-4" />{{ t("nav.connect") }}</TabsTrigger>
          <TabsTrigger value="models"><Cpu class="h-4 w-4" />{{ t("nav.models") }}</TabsTrigger>
          <TabsTrigger value="logs"><Activity class="h-4 w-4" />{{ t("nav.logs") }}</TabsTrigger>
          <TabsTrigger value="stats"><BarChart3 class="h-4 w-4" />{{ t("nav.stats") }}</TabsTrigger>
          <TabsTrigger value="settings"><SettingsIcon class="h-4 w-4" />{{ t("nav.settings") }}</TabsTrigger>
        </TabsList>
        <TabsContent value="connect"><Connect /></TabsContent>
        <TabsContent value="models"><Models /></TabsContent>
        <TabsContent value="logs"><Logs /></TabsContent>
        <TabsContent value="stats"><Stats /></TabsContent>
        <TabsContent value="settings"><Settings /></TabsContent>
      </Tabs>
    </main>
  </div>

  <Toaster />
</template>
