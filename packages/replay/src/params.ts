// Scenario parameters for the replay harness (E03). Defaults come from
// `config/params.json` (PRD §4.5, the single source of truth), validated with
// the service's ParamSchema; a scenario may shallowly override top-level keys.
import fs from 'node:fs';
import path from 'node:path';
import { ParamSchema } from '../../../apps/service/src/config.js';
import type { Params } from '../../../packages/activation/src/types.js';

const PARAMS_PATH = path.resolve(import.meta.dirname, '../../../config/params.json');

export function defaultParams(): Params {
  const raw = JSON.parse(fs.readFileSync(PARAMS_PATH, 'utf8')) as unknown;
  return ParamSchema.parse(raw);
}

// Shallow merge: scenario `params` overrides top-level keys of the defaults.
export function mergeParams(base: Params, override: Partial<Params>): Params {
  return ParamSchema.parse({ ...base, ...override });
}
