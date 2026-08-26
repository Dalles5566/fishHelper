import test from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import { computeHourlyBlocks, buildSummary, requestFishingAnalysis } from '../src/agent/tools/analyzeFishing.js';
import { getStormglass } from '../src/services/dataSource/stormglass.js';
import {
  buildPredict,
  collectSourceErrors,
  DEFAULT_TIMEZONE,
  selectCurrentWave,
  validatePredictionDate,
} from '../src/services/spotConditions.js';
import { selectForecastPeriods } from '../src/services/dataSource/nationalWeatherService.js';

test('Stormglass-only data forms a localized prediction timeline', () => {
  const stormglass = {
    prediction: {
      hourly: [{
        time: '2026-08-18T14:00:00+00:00',
        waterTemperature: 70,
        currentSpeed: 0.25,
        currentDirection: 90,
        waveHeight: 1.5,
        wavePeriod: 6,
        waveDirection: 110,
      }],
    },
  };

  const result = buildPredict(null, null, stormglass, 'America/New_York', 'english');
  assert.equal(result.hourly.length, 1);
  assert.equal(result.hourly[0].time, '2026-08-18T10:00:00-04:00');
  assert.equal(result.hourly[0].waterTemperature, 70);
  assert.equal(result.hourly[0].waveSource, 'Stormglass');
  assert.equal(result.hourly[0].waveDirection, 110);
});

test('prediction uses the union of all source hours and converts CO-OPS cm/s to m/s', () => {
  const coops = { prediction: { hourly: [{ time: '2026-08-18T14:00:00Z', speed: 50, direction: 45 }] } };
  const nws = { prediction: { hourly: [{ time: '2026-08-18T15:00:00Z', temperature: 22 }] } };
  const stormglass = { prediction: { hourly: [{ time: '2026-08-18T16:00:00+00:00', waveHeight: 0.5 }] } };

  const result = buildPredict(coops, nws, stormglass, 'America/New_York', 'metric');
  assert.equal(result.hourly.length, 3);
  assert.equal(result.hourly[0].tidalCurrentSpeed, 0.5);
  assert.equal(result.hourly[1].temperature, 22);
  assert.equal(result.hourly[2].waveHeight, 0.5);
});

test('future-day filtering is applied after localization', () => {
  const stormglass = {
    prediction: {
      hourly: [
        { time: '2026-08-18T03:00:00Z', waterTemperature: 69 },
        { time: '2026-08-18T04:00:00Z', waterTemperature: 70 },
      ],
    },
  };

  const result = buildPredict(null, null, stormglass, 'America/New_York', 'english', '2026-08-18');
  assert.equal(result.hourly.length, 1);
  assert.equal(result.hourly[0].time, '2026-08-18T00:00:00-04:00');
});

test('three-hour blocks use circular direction mean and identify cross-day ranges', () => {
  const blocks = computeHourlyBlocks([
    { time: '2026-08-17T23:00:00-04:00', tidalCurrentSpeed: 0.2, tidalCurrentDirection: 350 },
    { time: '2026-08-18T00:00:00-04:00', tidalCurrentSpeed: 0.3, tidalCurrentDirection: 10 },
    { time: '2026-08-18T01:00:00-04:00', tidalCurrentSpeed: 0.4, tidalCurrentDirection: 350 },
  ]);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].range, '21:00-23:59');
  assert.equal(blocks[1].range, '00:00-02:59');
  assert.match(blocks[1].tidalCurrent, /\/ 0°$/);
});

test('prediction summary renders water temperature even without NWS weather', () => {
  const blocks = computeHourlyBlocks([
    { time: '2026-08-18T09:00:00-04:00', waterTemperature: 70 },
  ]);
  const summary = buildSummary({
    currentTime: '2026-08-18T08:00:00-04:00',
    common: {},
    predictTideAndWeather: { tideExtremes: [], alerts: [] },
  }, blocks, 'zh');

  assert.match(summary, /水温: 70°F \(21°C\)/);
});

test('current summary does not print an empty direction separator', () => {
  const summary = buildSummary({
    currentTime: '2026-08-18T08:00:00-04:00',
    common: {},
    tideExtremes: [],
    currentTideAndWeather: {
      airTemp: null,
      shortForecast: null,
      precipitationProbability: null,
      thunderstormProbability: null,
      wind: {},
      waterTemp: null,
      tidalCurrentSpeed: 1,
      tidalCurrentDirection: null,
      waveHeight: null,
      wavePeriod: null,
      alerts: [],
    },
  }, null, 'zh');

  assert.match(summary, /潮流: 1 kt \(1 mph\)$/m);
  assert.doesNotMatch(summary, /潮流:.*\/\s*$/m);
});

test('prediction date validation rejects malformed, past, and out-of-range dates', () => {
  const now = new Date('2026-08-17T16:00:00Z');
  assert.equal(validatePredictionDate('2026-08-17', now), '2026-08-17');
  assert.equal(validatePredictionDate('2026-08-24', now), '2026-08-24');
  assert.throws(() => validatePredictionDate('2026-02-30', now), /invalid calendar date/);
  assert.throws(() => validatePredictionDate('2026-08-16', now), /past/);
  assert.throws(() => validatePredictionDate('2026-08-25', now), /7-day/);
});

test('NWS target-date selection never substitutes another day', () => {
  const periods = [
    { startTime: '2026-08-18T09:00:00-04:00' },
    { startTime: '2026-08-18T10:00:00-04:00' },
  ];
  assert.deepEqual(selectForecastPeriods(periods, { date: '2026-08-19', hours: 24 }), []);
  assert.equal(selectForecastPeriods(periods, { date: '2026-08-18', hours: 24 }).length, 2);
});

test('Stormglass handles short 429 cooldown, rotates keys, and requests wave direction once', async () => {
  const originalFetch = globalThis.fetch;
  const originalKeys = config.stormglass.apiKeys;
  const calls = [];
  config.stormglass.apiKeys = ['test-key-a', 'test-key-b'];

  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), authorization: options?.headers?.Authorization });
    if (calls.length === 1) {
      return new Response('', { status: 429, headers: { 'Retry-After': '2' } });
    }
    return new Response(JSON.stringify({
      hours: [{
        time: new Date().toISOString(),
        waterTemperature: { sg: 20 },
        currentSpeed: { sg: 0.5 },
        currentDirection: { sg: 90 },
        waveHeight: { sg: 1 },
        wavePeriod: { sg: 6 },
        waveDirection: { sg: 120 },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await getStormglass(41.5, -71.3, { mode: 'current', unitSystem: 'english' });
    assert.equal(result.available, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.authorization), ['test-key-a', 'test-key-b']);
    const requested = new URL(calls[0].url);
    assert.match(requested.searchParams.get('params'), /waveDirection/);
    const durationMs = Date.parse(requested.searchParams.get('end')) - Date.parse(requested.searchParams.get('start'));
    assert.equal(durationMs, 4 * 60 * 60 * 1000);
    assert.equal(result.current.waveDirection, 120);
    assert.match(result.errors[0].message, /rate limited/);
  } finally {
    globalThis.fetch = originalFetch;
    config.stormglass.apiKeys = originalKeys;
  }
});


test('missing tidal-current directions do not become false 0-degree samples', () => {
  const blocks = computeHourlyBlocks([
    { time: '2026-08-18T09:00:00-04:00', tidalCurrentSpeed: 0.2, tidalCurrentDirection: 90 },
    { time: '2026-08-18T10:00:00-04:00', tidalCurrentSpeed: 0.3, tidalCurrentDirection: null },
  ]);
  assert.match(blocks[0].tidalCurrent, /\/ 90°$/);
});

test('prediction wave fields fall back independently', () => {
  const time = '2026-08-18T14:00:00Z';
  const stormglass = { prediction: { hourly: [{ time, waveDirection: 120 }] } };
  const nws = { prediction: { hourly: [{ time, waveHeight: 2, wavePeriod: 7 }] } };
  const result = buildPredict(null, nws, stormglass, DEFAULT_TIMEZONE, 'english');
  assert.equal(result.hourly[0].waveHeight, 2);
  assert.equal(result.hourly[0].waveHeightSource, 'NWS');
  assert.equal(result.hourly[0].wavePeriod, 7);
  assert.equal(result.hourly[0].wavePeriodSource, 'NWS');
  assert.equal(result.hourly[0].waveDirection, 120);
  assert.equal(result.hourly[0].waveDirectionSource, 'Stormglass');
  assert.equal(result.hourly[0].waveSource, 'Mixed');
});

test('current wave fields independently fall through Stormglass, NWS, and NDBC', () => {
  const result = selectCurrentWave(
    { time: '2026-08-18T14:00:00Z', wavePeriod: 6 },
    { time: '2026-08-18T14:00:00Z', waveHeight: 2 },
    { observedAt: '2026-08-18T13:50:00Z', waveHeight: 3, wavePeriod: 8, waveDirection: 110 }
  );
  assert.equal(result.height, 2);
  assert.equal(result.heightSource, 'NWS');
  assert.equal(result.period, 6);
  assert.equal(result.periodSource, 'Stormglass');
  assert.equal(result.direction, 110);
  assert.equal(result.directionSource, 'NOAA NDBC');
  assert.equal(result.source, 'Mixed');
});

test('source errors are promoted and deduplicated', () => {
  const errors = [];
  const source = {
    source: 'Stormglass',
    errors: [
      { step: 'weather', message: 'rate limited' },
      { step: 'weather', message: 'rate limited' },
    ],
  };
  collectSourceErrors(errors, source);
  assert.deepEqual(errors, [{ source: 'Stormglass', step: 'weather', message: 'rate limited' }]);
});

test('fishing analysis disables OpenAI SDK retries', async () => {
  let calls = 0;
  let requestOptions;
  const fakeClient = {
    chat: {
      completions: {
        create: async (_body, options) => {
          calls += 1;
          requestOptions = options;
          throw new Error('simulated outage');
        },
      },
    },
  };

  await assert.rejects(() => requestFishingAnalysis({ targetSpecies: [] }, 'en', fakeClient), /simulated outage/);
  assert.equal(calls, 1);
  assert.equal(requestOptions.maxRetries, 0);
});

test('Stormglass distinguishes daily quota exhaustion from invalid keys', async () => {
  const originalFetch = globalThis.fetch;
  const originalKeys = config.stormglass.apiKeys;
  const calls = [];
  config.stormglass.apiKeys = ['quota-key', 'invalid-key'];
  globalThis.fetch = async (_url, options) => {
    calls.push(options?.headers?.Authorization);
    return new Response('', { status: calls.length === 1 ? 402 : 403 });
  };

  try {
    const result = await getStormglass(41.5, -71.3, { mode: 'current', unitSystem: 'english' });
    assert.equal(result.available, false);
    assert.deepEqual(calls, ['quota-key', 'invalid-key']);
    assert.ok(result.errors.some((error) => /daily quota exhausted/.test(error.message)));
    assert.ok(result.errors.some((error) => /invalid\/expired/.test(error.message)));
  } finally {
    globalThis.fetch = originalFetch;
    config.stormglass.apiKeys = originalKeys;
  }
});

test('concurrent Stormglass requests spread across available keys', async () => {
  const originalFetch = globalThis.fetch;
  const originalKeys = config.stormglass.apiKeys;
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  config.stormglass.apiKeys = ['concurrent-a', 'concurrent-b'];

  globalThis.fetch = async (_url, options) => {
    calls.push(options?.headers?.Authorization);
    if (calls.length === 2) release();
    await gate;
    return new Response(JSON.stringify({
      hours: [{ time: new Date().toISOString(), waveHeight: { sg: 1 }, wavePeriod: { sg: 6 } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const [first, second] = await Promise.all([
      getStormglass(41.5, -71.3, { mode: 'current', unitSystem: 'english' }),
      getStormglass(41.6, -71.4, { mode: 'current', unitSystem: 'english' }),
    ]);
    assert.equal(first.available, true);
    assert.equal(second.available, true);
    assert.deepEqual(new Set(calls), new Set(['concurrent-a', 'concurrent-b']));
  } finally {
    globalThis.fetch = originalFetch;
    config.stormglass.apiKeys = originalKeys;
  }
});