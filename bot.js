// sim.de Nachbuch-Bot
// Loggt sich regelmaessig in die sim.de Servicewelt ein, prueft das Datenvolumen
// und bucht automatisch das 2-GB-Highspeed-Paket nach, wenn es fast leer ist.
//   Start: 3_starten.bat   |   Test (bucht nicht): 2_test.bat

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ORDNER = __dirname;
const LOGDATEI = path.join(ORDNER, "bot.log");
const BASIS = "https://service.sim.de";

function log(text) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const zeile = `[${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}] ${text}`;
  console.log(zeile);
  try { fs.appendFileSync(LOGDATEI, zeile + "\n", "utf8"); } catch {}
}

function ladeConfig() {
  const datei = path.join(ORDNER, "config.ini");
  const werte = {};
  // Cloud: Werte kommen aus GitHub-Secrets (Umgebungsvariablen)
  if (process.env.SIMDE_USER) {
    werte.benutzername = process.env.SIMDE_USER;
    werte.passwort = process.env.SIMDE_PASS || "";
    werte.rufnummer = process.env.SIMDE_NUMMER || "";
    werte.nachbuchen_unter_gb = process.env.SIMDE_SCHWELLE || "1.5";
  } else if (!fs.existsSync(datei)) { log("config.ini fehlt!"); process.exit(1); }
  for (const roh of (process.env.SIMDE_USER ? [] : fs.readFileSync(datei, "utf8").split(/\r?\n/))) {
    const z = roh.trim();
    if (!z || z.startsWith(";") || z.startsWith("#") || z.startsWith("[")) continue;
    const i = z.indexOf("=");
    if (i > 0) werte[z.slice(0, i).trim().toLowerCase()] = z.slice(i + 1).trim();
  }
  const c = {
    user: werte.benutzername || "",
    pass: werte.passwort || "",
    nummer: (werte.rufnummer || "").replace(/\s/g, ""),
    schwelle: parseFloat((werte.nachbuchen_unter_gb || "1.5").replace(",", ".")),
    intervall: parseInt(werte.pruefen_alle_minuten || "10", 10),
    pause: parseInt(werte.pause_nach_buchung_minuten || "30", 10),
    sichtbar: /^(ja|yes|1|true)$/i.test(werte.browser_anzeigen || "nein"),
  };
  if (!c.user || !c.pass || c.user.includes("HIER") || c.pass.includes("HIER")) {
    log("Benutzername/Passwort fehlen (config.ini bzw. GitHub-Secrets SIMDE_USER/SIMDE_PASS).");
    process.exit(1);
  }
  return c;
}

const zahl = (t) => parseFloat(t.replace(/\./g, "").replace(",", "."));
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

async function sichtbar(loc, ms = 800) {
  try { return (await loc.count()) > 0 && (await loc.first().isVisible({ timeout: ms })); } catch { return false; }
}

async function cookieBannerWegklicken(page) {
  const box = page.locator("#__tealiumGDPRcpPrefs");
  const bereich = (await sichtbar(box, 1500)) ? box : page;
  // Bevorzugt ablehnen / nur notwendige, dann "Bestaetigen" (aktuelle Auswahl), zuletzt akzeptieren
  const namen = [/ablehnen/i, /nur notwendig/i, /nur erforderlich/i, /auswahl bestätigen/i,
    /^\s*bestätigen\s*$/i, /alle akzeptieren/i, /akzeptieren/i, /zustimmen/i];
  for (const n of namen) {
    const b = bereich.getByRole("button", { name: n });
    if (await sichtbar(b, 300)) { await b.first().click().catch(() => {}); await page.waitForTimeout(800); break; }
  }
  if (await sichtbar(page.locator("#consent_wall_optin"), 300)) {
    await page.locator("#consent_wall_optin").click().catch(() => {});
    await page.waitForTimeout(800);
  }
  // Falls immer noch etwas im Weg ist: Overlay ausblenden
  await page.evaluate(() => {
    for (const s of ["#consentOverlay", "#__tealiumGDPRcpPrefs", "#__tealiumGDPRecModal"]) {
      const e = document.querySelector(s); if (e) e.style.display = "none";
    }
  }).catch(() => {});
}

async function einloggen(page, c) {
  await page.goto(BASIS + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await cookieBannerWegklicken(page);
  if (page.url().includes("/start") || (await page.locator(".switch-user-control").count()) > 0) return true;

  try {
    await page.locator("#UserLoginType_alias").fill(c.user);
    await page.locator("#UserLoginType_password").fill(c.pass);
    await Promise.all([
      page.waitForURL((u) => !u.pathname.match(/^\/?$/), { timeout: 20000 }).catch(() => {}),
      page.locator("#loginAction a.c-button").first().click(),
    ]);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2500);
  } catch (e) {
    log("Login-Formular nicht gefunden: " + e.message);
    return false;
  }

  const text = await page.innerText("body");
  if (!page.url().includes("/start")) {
    if (/Sicherheitscode|Zwei-Faktor|Bestätigungscode/i.test(text) && (await page.locator("input[type=password]").count()) === 0) {
      log("Die Seite will einen Zwei-Faktor-Code. Das kann der Bot nicht – bitte 2FA in der Servicewelt ausschalten.");
      return false;
    }
    if (/falsch|ungültig|fehlgeschlagen/i.test(text)) {
      log("Login fehlgeschlagen – Benutzername/Passwort in config.ini pruefen.");
      return false;
    }
  }
  return true;
}

async function richtigenVertragWaehlen(page, c) {
  if (!c.nummer) return;
  if (!page.url().includes("/start")) await page.goto(BASIS + "/start", { waitUntil: "domcontentloaded" });
  const auswahl = page.locator("select.switch-user-control");
  if ((await auswahl.count()) === 0) return;
  const optionen = await auswahl.first().locator("option").evaluateAll((os) => os.map((o) => ({ t: o.textContent, sel: o.selected })));
  const i = optionen.findIndex((o) => (o.t || "").includes(c.nummer));
  if (i < 0) { log("Rufnummer nicht gefunden – nutze aktuellen Vertrag."); return; }
  if (optionen[i].sel) return;
  log("Wechsle auf den Unlimited-Vertrag ...");
  await auswahl.first().selectOption({ index: i });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2500);
}

async function volumenLesen(page) {
  await page.goto(BASIS + "/mytariff/invoice/showGprsDataUsage", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await cookieBannerWegklicken(page);
  const text = await page.innerText("body");
  const m = text.match(/([\d.,]+)\s*GB\s+von\s+([\d.,]+)\s*GB\s+verbraucht/);
  if (!m) return null;
  return { verbraucht: zahl(m[1]), gesamt: zahl(m[2]) };
}

async function nachbuchen(page) {
  let knopf = page.getByRole("link", { name: /^\s*Buchen\s*$/i });
  if ((await knopf.count()) === 0) knopf = page.locator("a.c-button:has-text('Buchen'), button:has-text('Buchen')");
  if ((await knopf.count()) === 0) { log("Kein 'Buchen'-Knopf gefunden (vielleicht gerade nicht buchbar)."); return false; }

  await cookieBannerWegklicken(page);
  await knopf.first().click({ timeout: 15000 });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2500);

  // Bestaetigungs-Fenster ("2 GB-Highspeed-Datenpaket ... kostenlos" -> "Aktivieren")
  for (const n of [/^\s*Aktivieren\s*$/i, /Jetzt buchen/i, /Buchung bestätigen/i, /^\s*Ja\s*$/i]) {
    let b = page.getByRole("button", { name: n });
    if (!(await sichtbar(b, 1500))) b = page.getByRole("link", { name: n });
    if (!(await sichtbar(b, 500))) b = page.locator("a, button, input[type=submit]").filter({ hasText: n });
    if (!(await sichtbar(b, 500))) b = page.locator("input[value='Aktivieren' i]");
    if (!(await sichtbar(b, 500))) b = page.getByText(n);
    if (await sichtbar(b, 500)) {
      log("Bestaetige mit '" + (await b.first().innerText()).trim() + "' ...");
      await b.first().click();
      await page.waitForTimeout(2000);
      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);
      break;
    }
  }
  try { await page.screenshot({ path: path.join(ORDNER, "letzte_buchung.png"), fullPage: true }); } catch {}
  try {
    const info = await page.evaluate(() => [...document.querySelectorAll("*")]
      .filter((e) => /Aktivieren/i.test(e.textContent || e.value || "") && e.children.length <= 2)
      .slice(-4).map((e) => e.outerHTML.slice(0, 300)).join("\n"));
    fs.writeFileSync(path.join(ORDNER, "debug_buchung.txt"), info + "\nFrames: " + page.frames().map((f) => f.url()).join(", "), "utf8");
  } catch {}
  const text = await page.innerText("body");
  if (/erfolgreich|gebucht|freigeschaltet|vielen dank/i.test(text)) log("Nachbuchung erfolgreich!");
  else log("Buchen geklickt – Ergebnis unklar, siehe letzte_buchung.png.");
  return true;
}

async function einDurchlauf(c, testModus) {
  const browser = await chromium.launch({ headless: !c.sichtbar });
  const page = await browser.newPage({ locale: "de-DE" });
  try {
    if (!(await einloggen(page, c))) return false;
    await richtigenVertragWaehlen(page, c);
    const v = await volumenLesen(page);
    if (!v) {
      log("Konnte das Datenvolumen nicht lesen.");
      await page.screenshot({ path: path.join(ORDNER, "fehler.png"), fullPage: true }).catch(() => {});
      return false;
    }
    const rest = v.gesamt - v.verbraucht;
    log(`${v.verbraucht.toFixed(2)} von ${v.gesamt.toFixed(2)} GB verbraucht – noch ${rest.toFixed(2)} GB frei.`);
    if (rest < c.schwelle) {
      if (testModus) { log(`TEST: Wuerde jetzt nachbuchen (unter ${c.schwelle} GB). Es wurde NICHT gebucht.`); return false; }
      log("Wird knapp – buche 2 GB nach ...");
      return await nachbuchen(page);
    }
    return false;
  } finally {
    await browser.close();
  }
}

(async () => {
  const testModus = process.argv.includes("--test");
  const c = ladeConfig();
  log(`Bot gestartet${testModus ? " (TEST-Modus, bucht nicht)" : ""} – prueft alle ${c.intervall} Min., bucht unter ${c.schwelle} GB.`);
  if (process.argv.includes("--einmal")) {
    // Cloud-Modus: genau ein Durchlauf, dann Ende
    try { await einDurchlauf(c, false); } catch (e) { log("Fehler: " + String(e.message).split("\n")[0]); process.exitCode = 1; }
    return;
  }
  if (testModus) {
    try { await einDurchlauf(c, true); } catch (e) { log("Fehler: " + String(e.message).split("\n")[0]); }
    return;
  }
  let pauseBis = 0;
  while (true) {
    if (Date.now() >= pauseBis) {
      try {
        if (await einDurchlauf(c, false)) {
          pauseBis = Date.now() + c.pause * 60000;
          log(`Naechste Buchung fruehestens in ${c.pause} Minuten.`);
        }
      } catch (e) { log("Fehler: " + String(e.message).split("\n")[0]); }
    }
    await warte(c.intervall * 60000);
  }
})();
