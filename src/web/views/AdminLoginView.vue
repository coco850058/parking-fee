<template>
  <main class="app-page admin-login-page">
    <div class="login-decoration" aria-hidden="true"></div>
    <div class="login-shell">
      <header class="login-brand">
        <div class="brand-icon"><van-icon name="setting-o" /></div>
        <div>
          <p>停车服务</p>
          <h1>管理后台</h1>
        </div>
      </header>

      <section class="surface-card login-card">
        <div class="login-heading">
          <h2>管理员登录</h2>
          <p>请输入后台管理密码</p>
        </div>

        <van-form validate-trigger="onSubmit" @submit="login">
          <van-field
            v-model="password"
            name="password"
            type="password"
            label="管理密码"
            placeholder="请输入密码"
            autocomplete="current-password"
            clearable
            :rules="[{ required: true, message: '请输入管理密码' }]"
          />
          <van-button
            round
            block
            type="primary"
            native-type="submit"
            class="login-button touch-button"
            :loading="submitting"
            loading-text="正在登录"
          >
            登录后台
          </van-button>
        </van-form>

        <div class="security-tip">
          <van-icon name="shield-o" />
          <span>请勿在公共设备上保存管理密码</span>
        </div>
      </section>

      <router-link class="back-link" to="/pay">
        <van-icon name="arrow-left" /> 返回缴费页面
      </router-link>
    </div>
  </main>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { showFailToast } from 'vant';
import { adminApi } from '../api';

const router = useRouter();
const password = ref('');
const submitting = ref(false);

async function login() {
  if (submitting.value) return;
  submitting.value = true;
  try {
    const result = await adminApi.login(password.value);
    if (!result.authenticated) throw new Error('登录状态异常，请重试');
    await router.replace('/admin');
  } catch (error) {
    showFailToast(error instanceof Error ? error.message : '登录失败，请检查密码');
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  try {
    const result = await adminApi.me();
    if (result.authenticated) await router.replace('/admin');
  } catch {
    // 未登录是此页面的正常状态。
  }
});
</script>

<style scoped>
.admin-login-page {
  position: relative;
  overflow: hidden;
  background:
    linear-gradient(180deg, var(--brand) 0, var(--brand) 36%, #f2f2f2 36%, #f2f2f2 100%);
}

.login-decoration {
  position: absolute;
  top: -90px;
  right: -65px;
  width: 230px;
  height: 230px;
  border: 38px solid rgba(255, 255, 255, 0.06);
  border-radius: 50%;
}

.login-shell {
  position: relative;
  z-index: 1;
  width: 100%;
  padding: max(46px, calc(env(safe-area-inset-top) + 24px)) 18px 24px;
}

.login-brand {
  display: flex;
  align-items: center;
  padding: 0 6px 28px;
  color: #fff;
}

.brand-icon {
  display: grid;
  width: 48px;
  height: 48px;
  margin-right: 13px;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 15px;
  background: rgba(255, 255, 255, 0.14);
  font-size: 24px;
}

.login-brand p,
.login-brand h1 {
  margin: 0;
}

.login-brand p {
  margin-bottom: 3px;
  color: rgba(255, 255, 255, 0.72);
  font-size: 12px;
  letter-spacing: 0.12em;
}

.login-brand h1 {
  font-size: 23px;
}

.login-card {
  padding: 25px 18px 20px;
}

.login-heading {
  padding: 0 4px 20px;
}

.login-heading h2 {
  margin: 0;
  font-size: 21px;
}

.login-heading p {
  margin: 7px 0 0;
  color: var(--muted);
  font-size: 13px;
}

.login-card :deep(.van-field) {
  min-height: 58px;
  margin-bottom: 20px;
  padding: 8px 13px;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: #fafafa;
}

.login-card :deep(.van-field::after) {
  display: none;
}

.login-card :deep(.van-field__label) {
  width: 4.5em;
  font-weight: 600;
}

.login-button {
  height: 48px;
  box-shadow: 0 8px 19px rgba(0, 113, 220, 0.21);
}

.security-tip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  margin-top: 16px;
  color: var(--muted);
  font-size: 11px;
}

.security-tip .van-icon {
  color: var(--brand);
}

.back-link {
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin-top: 16px;
  color: var(--muted);
  font-size: 13px;
  text-decoration: none;
}
</style>
