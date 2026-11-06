const prisma = require("../prisma");
const config = require("../config");

const settingsId = "store-settings";
const defaults = {
  shippingChargePaise: config.shippingChargePaise,
  codChargePaise: config.codChargePaise,
  brandName: "Naju's Magic Shop",
  logoUrl: null,
};
let currentSettings = { ...defaults };

function publicSettings(settings = currentSettings) {
  return {
    shippingChargePaise: settings.shippingChargePaise,
    codChargePaise: settings.codChargePaise,
    brandName: settings.brandName || defaults.brandName,
    logoUrl: settings.logoUrl || "",
  };
}

async function loadStoreSettings() {
  const settings = await prisma.storeSettings.upsert({
    where: { id: settingsId },
    create: { id: settingsId, ...defaults },
    update: {},
  });
  currentSettings = publicSettings(settings);
  return publicSettings();
}

function getStoreSettings() {
  return publicSettings();
}

async function getCurrentStoreSettings() {
  const settings = await prisma.storeSettings.findUnique({
    where: { id: settingsId },
  });
  if (settings) currentSettings = publicSettings(settings);
  return publicSettings();
}

async function saveStoreSettings(changes) {
  const settings = await prisma.storeSettings.upsert({
    where: { id: settingsId },
    create: { id: settingsId, ...defaults, ...changes },
    update: changes,
  });
  currentSettings = publicSettings(settings);
  return publicSettings();
}

module.exports = {
  getStoreSettings,
  getCurrentStoreSettings,
  loadStoreSettings,
  saveStoreSettings,
};
