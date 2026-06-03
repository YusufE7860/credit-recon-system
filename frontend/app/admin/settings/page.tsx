'use client';

import { useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { api, ApiError } from '@/lib/api';

// Mirrors backend SETTING_KEYS exactly. Adding a new key requires
// touching both ends.
const KEYS = {
  SMTP_HOST: 'smtp.host',
  SMTP_PORT: 'smtp.port',
  SMTP_SECURE: 'smtp.secure',
  SMTP_USER: 'smtp.user',
  SMTP_PASS: 'smtp.pass',
  MAIL_FROM: 'mail.from',
  FX_USD: 'fx.usd', FX_EUR: 'fx.eur', FX_GBP: 'fx.gbp',
  FX_CNY: 'fx.cny', FX_JPY: 'fx.jpy', FX_SAR: 'fx.sar',
  FX_AED: 'fx.aed', FX_AUD: 'fx.aud', FX_CAD: 'fx.cad', FX_INR: 'fx.inr',
  FX_MARKUP_PERCENT: 'fx.markupPercent',
  RECON_AMOUNT_TOLERANCE: 'recon.amountTolerance',
  RECON_DATE_TOLERANCE_DAYS: 'recon.dateToleranceDays',
  RECON_MERCHANT_THRESHOLD: 'recon.merchantThreshold',
  RECON_MIN_SCORE: 'recon.minScore',
  EDIT_UNLOCK_HOURS: 'editRequest.unlockHours',
  AI_ANTHROPIC_KEY: 'ai.anthropicKey',
  AI_MODEL: 'ai.model',
  AI_FALLBACK_MODEL: 'ai.fallbackModel',
  AI_FALLBACK_THRESHOLD: 'ai.fallbackThreshold',
} as const;

type Tab = 'mail' | 'fx' | 'recon' | 'edit' | 'ai';

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('mail');
  const [values, setValues] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    api<Record<string, any>>('/settings')
      .then(setValues)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  function set(key: string, value: any) {
    setValues({ ...values, [key]: value });
  }

  async function save() {
    setSaving(true); setError(''); setMessage('');
    try {
      await api('/settings', { method: 'PATCH', json: values });
      setMessage('Settings saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="flex min-h-screen bg-gray-100">
      <Sidebar />
      <section className="flex-1 min-w-0 p-4 pt-16 md:p-8 max-w-3xl">
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-gray-600 mt-1 mb-6">
          Runtime configuration — saved values override the .env file. Empty fields fall back to env or hard-coded defaults.
        </p>

        <div className="flex gap-1 mb-6 border-b border-gray-300">
          <TabBtn active={tab === 'mail'}  onClick={() => setTab('mail')}>Mail</TabBtn>
          <TabBtn active={tab === 'fx'}    onClick={() => setTab('fx')}>FX rates</TabBtn>
          <TabBtn active={tab === 'recon'} onClick={() => setTab('recon')}>Reconciliation</TabBtn>
          <TabBtn active={tab === 'edit'}  onClick={() => setTab('edit')}>Edit unlock</TabBtn>
          <TabBtn active={tab === 'ai'}    onClick={() => setTab('ai')}>AI / OCR</TabBtn>
        </div>

        {error && <p className="text-sm text-red-600 bg-red-50 p-3 rounded mb-4">{error}</p>}
        {message && <p className="text-sm text-green-700 bg-green-50 p-3 rounded mb-4">{message}</p>}

        {loading ? <p>Loading...</p> : (
          <div className="bg-white rounded-xl shadow p-6 space-y-4">
            {tab === 'mail' && (
              <>
                <Field label="SMTP host" value={values[KEYS.SMTP_HOST]} onChange={(v) => set(KEYS.SMTP_HOST, v)} placeholder="smtp.gmail.com" />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Port" type="number" value={values[KEYS.SMTP_PORT]} onChange={(v) => set(KEYS.SMTP_PORT, Number(v))} placeholder="587" />
                  <SelectField label="TLS / Secure" value={String(values[KEYS.SMTP_SECURE] ?? 'false')} onChange={(v) => set(KEYS.SMTP_SECURE, v === 'true')} options={[['false','false (STARTTLS, port 587)'], ['true','true (SSL, port 465)']]} />
                </div>
                <Field label="Username" value={values[KEYS.SMTP_USER]} onChange={(v) => set(KEYS.SMTP_USER, v)} placeholder="username or API key" />
                <Field label="Password" type="password" value={values[KEYS.SMTP_PASS] === '__set__' ? '' : values[KEYS.SMTP_PASS]} onChange={(v) => set(KEYS.SMTP_PASS, v)} placeholder={values[KEYS.SMTP_PASS] === '__set__' ? '••••••• (saved — type to replace)' : 'password'} />
                <Field label="From address" value={values[KEYS.MAIL_FROM]} onChange={(v) => set(KEYS.MAIL_FROM, v)} placeholder='FFG Recon <noreply@yourdomain.co.za>' />
                <p className="text-xs text-gray-500">If any of host/user is blank, the mailer logs reset emails to the backend console instead of sending.</p>
              </>
            )}

            {tab === 'fx' && (
              <>
                <Field
                  label="Bank markup (%)"
                  type="number"
                  value={values[KEYS.FX_MARKUP_PERCENT]}
                  onChange={(v) => set(KEYS.FX_MARKUP_PERCENT, Number(v))}
                  placeholder="2.5"
                />
                <p className="text-xs text-gray-500 -mt-3 mb-3">
                  Applied to EVERY foreign-currency invoice. SA card issuers
                  add 2–3.5% on top of the published rate when they convert.
                  Without this markup, invoice ZAR amounts will be ~3% lower
                  than the actual bank charge and won&apos;t auto-match.
                  Set to 0 to use the raw published rate.
                </p>
                <hr className="my-2" />
                <p className="text-xs text-gray-600 mb-2">
                  Fallback rates below are only used when the historical FX
                  lookup fails (Frankfurter unreachable, or the currency
                  isn&apos;t on its list — SAR / AED).
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="USD → ZAR" type="number" value={values[KEYS.FX_USD]} onChange={(v) => set(KEYS.FX_USD, Number(v))} />
                  <Field label="GBP → ZAR" type="number" value={values[KEYS.FX_GBP]} onChange={(v) => set(KEYS.FX_GBP, Number(v))} />
                  <Field label="EUR → ZAR" type="number" value={values[KEYS.FX_EUR]} onChange={(v) => set(KEYS.FX_EUR, Number(v))} />
                  <Field label="CNY → ZAR" type="number" value={values[KEYS.FX_CNY]} onChange={(v) => set(KEYS.FX_CNY, Number(v))} />
                  <Field label="JPY → ZAR" type="number" value={values[KEYS.FX_JPY]} onChange={(v) => set(KEYS.FX_JPY, Number(v))} />
                  <Field label="SAR → ZAR" type="number" value={values[KEYS.FX_SAR]} onChange={(v) => set(KEYS.FX_SAR, Number(v))} />
                  <Field label="AED → ZAR" type="number" value={values[KEYS.FX_AED]} onChange={(v) => set(KEYS.FX_AED, Number(v))} />
                  <Field label="AUD → ZAR" type="number" value={values[KEYS.FX_AUD]} onChange={(v) => set(KEYS.FX_AUD, Number(v))} />
                  <Field label="CAD → ZAR" type="number" value={values[KEYS.FX_CAD]} onChange={(v) => set(KEYS.FX_CAD, Number(v))} />
                  <Field label="INR → ZAR" type="number" value={values[KEYS.FX_INR]} onChange={(v) => set(KEYS.FX_INR, Number(v))} />
                </div>
              </>
            )}

            {tab === 'recon' && (
              <>
                <Field label="Amount tolerance (ZAR)" type="number" value={values[KEYS.RECON_AMOUNT_TOLERANCE]} onChange={(v) => set(KEYS.RECON_AMOUNT_TOLERANCE, Number(v))} placeholder="0.05" />
                <p className="text-xs text-gray-500 -mt-3">Invoice/transaction amounts within this difference get a perfect amount score.</p>
                <Field label="Date tolerance (days)" type="number" value={values[KEYS.RECON_DATE_TOLERANCE_DAYS]} onChange={(v) => set(KEYS.RECON_DATE_TOLERANCE_DAYS, Number(v))} placeholder="5" />
                <p className="text-xs text-gray-500 -mt-3">Beyond this many days apart, the pair is rejected.</p>
                <Field label="Merchant similarity threshold (0–1)" type="number" value={values[KEYS.RECON_MERCHANT_THRESHOLD]} onChange={(v) => set(KEYS.RECON_MERCHANT_THRESHOLD, Number(v))} placeholder="0.4" />
                <Field label="Minimum match score (0–1)" type="number" value={values[KEYS.RECON_MIN_SCORE]} onChange={(v) => set(KEYS.RECON_MIN_SCORE, Number(v))} placeholder="0.6" />
                <p className="text-xs text-gray-500 -mt-3">Lower = more aggressive auto-matching (more false positives).</p>
              </>
            )}

            {tab === 'edit' && (
              <>
                <Field label="Edit unlock window (hours)" type="number" value={values[KEYS.EDIT_UNLOCK_HOURS]} onChange={(v) => set(KEYS.EDIT_UNLOCK_HOURS, Number(v))} placeholder="24" />
                <p className="text-xs text-gray-500 -mt-3">After admin approves an edit request, the user has this many hours to make their edit before the unlock expires.</p>
              </>
            )}

            {tab === 'ai' && (
              <>
                <p className="text-xs text-gray-600 -mt-2 mb-2">
                  When an Anthropic API key is configured, invoice uploads use Claude vision instead of Tesseract for OCR — dramatically higher accuracy on real-world receipts. Cost is ~R0.04 per invoice. Leave the key blank to use Tesseract.
                </p>
                <Field
                  label="Anthropic API key"
                  type="password"
                  value={values[KEYS.AI_ANTHROPIC_KEY] === '__set__' ? '' : values[KEYS.AI_ANTHROPIC_KEY]}
                  onChange={(v) => set(KEYS.AI_ANTHROPIC_KEY, v)}
                  placeholder={values[KEYS.AI_ANTHROPIC_KEY] === '__set__' ? '••••••• (saved — type to replace)' : 'sk-ant-api03-...'}
                />
                <p className="text-xs text-gray-500 -mt-3">
                  Get one at <a href="https://console.anthropic.com/" target="_blank" rel="noreferrer" className="text-orange-600 underline">console.anthropic.com</a>. Stored encrypted at rest. Never sent to the frontend after the first save.
                </p>
                <SelectField
                  label="Primary model"
                  value={values[KEYS.AI_MODEL] || 'claude-haiku-4-5-20251001'}
                  onChange={(v) => set(KEYS.AI_MODEL, v)}
                  options={[
                    ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5 — fast & cheap (recommended)'],
                    ['claude-sonnet-4-6', 'Claude Sonnet 4.6 — slower, more accurate, ~5x cost'],
                  ]}
                />
                <p className="text-xs text-gray-500 -mt-3">
                  Used for every invoice. Haiku handles most receipts.
                </p>

                <SelectField
                  label="Fallback model (auto-retry on low confidence)"
                  value={values[KEYS.AI_FALLBACK_MODEL] || 'claude-sonnet-4-6'}
                  onChange={(v) => set(KEYS.AI_FALLBACK_MODEL, v)}
                  options={[
                    ['claude-sonnet-4-6', 'Claude Sonnet 4.6 — better at tough cases'],
                    ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5 — same as primary (effectively disables fallback)'],
                    ['', 'Disabled — never retry'],
                  ]}
                />
                <p className="text-xs text-gray-500 -mt-3">
                  Only triggered when the primary returns low confidence or misses supplier/total/date. For faded thermal slips and handwritten notes.
                </p>

                <Field
                  label="Fallback confidence threshold (0–1)"
                  type="number"
                  value={values[KEYS.AI_FALLBACK_THRESHOLD]}
                  onChange={(v) => set(KEYS.AI_FALLBACK_THRESHOLD, Number(v))}
                  placeholder="0.65"
                />
                <p className="text-xs text-gray-500 -mt-3">
                  Below this confidence, the fallback model is invoked. 0.65 is a good balance — lower means fewer fallbacks (cheaper), higher means more fallbacks (more accurate).
                </p>
              </>
            )}

            <div className="pt-4">
              <button onClick={save} disabled={saving} className="bg-black text-white px-5 py-2 rounded-lg font-medium hover:opacity-90 disabled:opacity-40">
                {saving ? 'Saving...' : 'Save changes'}
              </button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${active ? 'border-orange-500 text-black' : 'border-transparent text-gray-600 hover:text-black'}`}>
      {children}
    </button>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text' }: { label: string; value: any; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input type={type} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500" />
    </div>
  );
}

function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500">
        {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
    </div>
  );
}
