import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const landingUrl = process.env.LIP_VISUAL_LANDING_URL ?? "http://127.0.0.1:4187/";
const adminUrl = process.env.LIP_VISUAL_ADMIN_URL ?? "http://127.0.0.1:4188/admin/";
const outputDirectory = resolve(process.env.LIP_VISUAL_OUTPUT_DIR ?? ".lip/visual-verification");
const chromeCandidates = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => existsSync(candidate));
if (!chrome) throw new Error("Set CHROME_BIN to a Chrome or Chromium executable");

const port = 19_000 + Math.floor(Math.random() * 1_000);
const profile = mkdtempSync(join(tmpdir(), "lip-visual-chrome-"));
const processHandle = spawn(chrome, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "about:blank"
], { stdio: "ignore" });

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function json(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${options?.method ?? "GET"} ${url} returned ${response.status}`);
  return response.json();
}

async function devtoolsReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      return await json(`http://127.0.0.1:${port}/json/version`);
    } catch {
      await wait(100);
    }
  }
  throw new Error("Chrome DevTools did not become ready");
}

class Cdp {
  constructor(socketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(socketUrl);
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", rejectOpen, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  event(method, timeout = 10_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const callback = (params) => {
        clearTimeout(timer);
        this.listeners.set(method, (this.listeners.get(method) ?? []).filter((item) => item !== callback));
        resolveEvent(params);
      };
      const timer = setTimeout(() => {
        this.listeners.set(method, (this.listeners.get(method) ?? []).filter((item) => item !== callback));
        rejectEvent(new Error(`Timed out waiting for ${method}`));
      }, timeout);
      this.listeners.set(method, [...(this.listeners.get(method) ?? []), callback]);
    });
  }

  close() {
    this.socket.close();
  }
}

async function newPage() {
  const target = await json(`http://127.0.0.1:${port}/json/new?about%3Ablank`, { method: "PUT" });
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable")]);
  return cdp;
}

async function viewport(cdp, width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 520,
    screenWidth: width,
    screenHeight: height
  });
}

async function navigate(cdp, url) {
  const loaded = cdp.event("Page.loadEventFired");
  await cdp.send("Page.navigate", { url });
  await loaded;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = await evaluate(cdp, "document.readyState === 'complete'");
    if (ready) return;
    await wait(100);
  }
  throw new Error(`${url} did not reach readyState=complete`);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "Browser evaluation failed");
  }
  return result.result.value;
}

async function screenshot(cdp, name) {
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  writeFileSync(join(outputDirectory, name), Buffer.from(result.data, "base64"));
}

function assertNoOverflow(name, metrics) {
  if (metrics.scrollWidth > metrics.clientWidth) {
    throw new Error(`${name} overflows: ${metrics.scrollWidth}px content in ${metrics.clientWidth}px viewport`);
  }
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`);
}

await devtoolsReady();
rmSync(outputDirectory, { recursive: true, force: true });
const { mkdirSync } = await import("node:fs");
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
const report = {};

try {
  const landing = await newPage();
  await viewport(landing, 1_440, 900);
  await navigate(landing, landingUrl);
  report.landing_desktop = await evaluate(landing, `({
    title: document.title,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    lifecycleSteps: document.querySelectorAll('.step').length,
    visibleRequest: Boolean(document.querySelector('#request')?.textContent?.includes('idempotency_key')),
    visibleResponse: Boolean(document.querySelector('#response')?.textContent?.includes('evaluation_id'))
  })`);
  assertNoOverflow("landing desktop", report.landing_desktop);
  assertEqual("landing lifecycle step count", report.landing_desktop.lifecycleSteps, 7);
  assertEqual("landing request visibility", report.landing_desktop.visibleRequest, true);
  assertEqual("landing response visibility", report.landing_desktop.visibleResponse, true);
  await screenshot(landing, "landing-desktop.png");

  report.walkthrough = await evaluate(landing, `(async () => {
    const next = document.querySelector('#next');
    for (let index = 0; index < 7; index += 1) {
      next.click();
      if (index < 6) next.click();
      await new Promise((resolveStep) => requestAnimationFrame(resolveStep));
    }
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, document.querySelector('#walkthrough').offsetTop);
    await new Promise((resolveScroll) => requestAnimationFrame(resolveScroll));
    return {
      done: document.querySelectorAll('.step.done').length,
      title: document.querySelector('#step-title').textContent,
      key: document.querySelector('#key').textContent,
      balance: document.querySelector('#balance').textContent,
      ledger: document.querySelector('#ledger').textContent,
      button: next.textContent
    };
  })()`);
  assertEqual("completed walkthrough steps", report.walkthrough.done, 7);
  assertEqual("completed walkthrough operation", report.walkthrough.title, "Refund adjust");
  assertEqual("completed walkthrough button", report.walkthrough.button, "Completed");
  await screenshot(landing, "landing-walkthrough-complete.png");

  await viewport(landing, 390, 844);
  await navigate(landing, landingUrl);
  report.landing_mobile = await evaluate(landing, `({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.getBoundingClientRect().width
  })`);
  assertNoOverflow("landing mobile", report.landing_mobile);
  await screenshot(landing, "landing-mobile.png");
  landing.close();

  const admin = await newPage();
  await viewport(admin, 1_440, 900);
  await navigate(admin, adminUrl);
  await wait(250);
  report.admin_login_desktop = await evaluate(admin, `({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    title: document.querySelector('h1')?.textContent?.trim(),
    keyPrefilled: document.querySelector('#api-key')?.value === 'lip-dev-key'
  })`);
  assertNoOverflow("Admin desktop login", report.admin_login_desktop);
  assertEqual("Admin local key prefill", report.admin_login_desktop.keyPrefilled, true);
  await screenshot(admin, "admin-login-desktop.png");

  await evaluate(admin, "document.querySelector('form').requestSubmit(); true");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const signedIn = await evaluate(admin, "Boolean(document.querySelector('.app-shell'))");
    if (signedIn) break;
    if (attempt === 49) throw new Error("Admin did not reach the authenticated shell");
    await wait(100);
  }
  report.admin_desktop = await evaluate(admin, `({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    heading: document.querySelector('h1')?.textContent?.trim(),
    navigation: [...document.querySelectorAll('.sidebar nav button')].map((item) => item.textContent.trim())
  })`);
  assertNoOverflow("Admin desktop", report.admin_desktop);
  await screenshot(admin, "admin-desktop.png");

  await viewport(admin, 390, 844);
  report.admin_mobile = await evaluate(admin, `({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    shellWidth: document.querySelector('.app-shell')?.getBoundingClientRect().width
  })`);
  assertNoOverflow("Admin mobile", report.admin_mobile);
  await screenshot(admin, "admin-mobile.png");
  admin.close();

  writeFileSync(join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, outputDirectory, report }, null, 2));
} finally {
  processHandle.kill("SIGTERM");
  rmSync(profile, { recursive: true, force: true });
}
