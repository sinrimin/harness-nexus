/**
 * Aggregate locale dictionaries. Every leaf in `strings/` owns its English and
 * Chinese copy side by side (the leaf types `zh` as `typeof en`, so key parity
 * is enforced where the strings are written). This file only zips them into
 * the two runtime dictionaries and derives the `TranslationKey` union that
 * `t()` is typed against.
 */
import { commonStrings } from './common.js';
import { appStrings } from './app.js';
import { loginStrings } from './login.js';
import { registerStrings } from './register.js';
import { settingsStrings } from './settings.js';
import { usersStrings } from './users.js';
import { dashboardStrings } from './dashboard.js';
import { credentialsStrings } from './credentials.js';
import { llmProvidersStrings } from './llmProviders.js';
import { tokensStrings } from './tokens.js';
import { profilesStrings } from './profiles.js';
import { resourcesStrings } from './resources.js';
import { mcpStrings } from './mcp.js';
import { machinesStrings } from './machines.js';
import { machineDetailStrings } from './machineDetail.js';
import { skillHubStrings } from './skillHub.js';
import { chatStrings } from './chat.js';
import { kitStrings } from './kit.js';

export const en = {
  common: commonStrings.en,
  app: appStrings.en,
  login: loginStrings.en,
  register: registerStrings.en,
  settings: settingsStrings.en,
  users: usersStrings.en,
  dashboard: dashboardStrings.en,
  credentials: credentialsStrings.en,
  llmProviders: llmProvidersStrings.en,
  tokens: tokensStrings.en,
  profiles: profilesStrings.en,
  resources: resourcesStrings.en,
  mcp: mcpStrings.en,
  machines: machinesStrings.en,
  machineDetail: machineDetailStrings.en,
  skillHub: skillHubStrings.en,
  chat: chatStrings.en,
  kit: kitStrings.en,
};

export const zh: typeof en = {
  common: commonStrings.zh,
  app: appStrings.zh,
  login: loginStrings.zh,
  register: registerStrings.zh,
  settings: settingsStrings.zh,
  users: usersStrings.zh,
  dashboard: dashboardStrings.zh,
  credentials: credentialsStrings.zh,
  llmProviders: llmProvidersStrings.zh,
  tokens: tokensStrings.zh,
  profiles: profilesStrings.zh,
  resources: resourcesStrings.zh,
  mcp: mcpStrings.zh,
  machines: machinesStrings.zh,
  machineDetail: machineDetailStrings.zh,
  skillHub: skillHubStrings.zh,
  chat: chatStrings.zh,
  kit: kitStrings.zh,
};

/** Dot-path union of every key in the English dictionary (e.g. `common.save`). */
export type TranslationKey = Paths<typeof en>;

type Paths<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Paths<T[K]>}`;
}[keyof T & string];
