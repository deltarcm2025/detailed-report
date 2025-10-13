import React, { useMemo, useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { ClipboardPaste, RefreshCw, Download, Search, Undo2 } from "lucide-react";
import Papa from "papaparse";
import * as d3 from "d3";

/**
 * Insurance Payment Analyzer (v6 — FIX)
 * This revision fixes build errors and logic drift from the last iteration:
 * - Removes duplicated/garbled functions and duplicate state declarations.
 * - Correct grouping key helpers.
 * - Ensures proxy = mode by freq with higher-$ tie-breaker (n<=2 => max).
 * - Keeps hover evidence, manual overrides, UHC alias merge, and units toggle.
 */

function normalizeHeader(h) {
  return (h || "")
    .toString()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "")
    .toUpperCase();
}

function getVal(row, key) {
  if (key in row) return row[key];
  const want = normalizeHeader(key);
  for (const k of Object.keys(row)) {
    if (normalizeHeader(k) === want) return row[k];
  }
  return undefined;
}

function toNum(x) {
  if (x === null || x === undefined || x === "") return 0;
  const s = String(x).replace(/\$/g, "").trim();
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
}

function normalizeModifiers(mod) {
  if (!mod) return "—";
  const toks = String(mod)
    .split(/[\,\s]+/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  const uniq = Array.from(new Set(toks)).sort();
  return uniq.length ? uniq.join("+") : "—";
}

// Collapse common payer aliases (extend as needed)
function normalizeInsurance(nameRaw) {
  const name = String(nameRaw || "").trim();
  const upper = name.toUpperCase();
  const UHCTokens = [
    "UNITED HEALTH",
    "UNITED HEALTH CARE",
    "UNITED HEALTHCARE",
    "UHC",
    "UHC – UNITEDHEALTHCARE",
    "UHC-UNITEDHEALTHCARE",
    "UHC – UNITED HEALTH CARE",
    "UNITED HEALTH CARE INSURANCE",
  ];
  if (UHCTokens.some((t) => upper.includes(t))) return "United Health Care";
  return name
    .replace(/\s+/g, " ")
    .replace(/\s+-\s+/g, " - ")
    .replace(/\s+INC$/i, "")
    .trim();
}

function computeAllowed(row) {
  const ins = Math.abs(toNum(getVal(row, "Insurance_Payment")));
  const pat = Math.max(0, toNum(getVal(row, "Patient_Payment")));
  const bal = Math.max(0, toNum(getVal(row, "Balance")));
  return +(ins + pat + bal).toFixed(2);
}

function percentDelta(v, ref) {
  if (!ref || ref === 0) return 0;
  return ((v - ref) / ref) * 100;
}

function fmt(n) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseText(text) {
  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
    delimiter: "", // auto-detect
  });
  return (parsed.data || []).map((r) => ({ ...r }));
}

function buildKey(g) {
  return `${g.Insurance}|${g.CPT}|${g.POS}|${g.Modifiers}|${g.Units}`;
}
function buildKeyNoUnits(g) {
  return `${g.Insurance}|${g.CPT}|${g.POS}|${g.Modifiers}`;
}

function enrichRows(raw) {
  return raw
    .map((r) => ({ ...r }))
    .filter((r) => String(getVal(r, "CPT") || "").trim() !== "")
    .map((r, idx) => {
      const allowed = computeAllowed(r);
      const insurancePaid = Math.abs(toNum(getVal(r, "Insurance_Payment")));
      const charges = Math.max(0, toNum(getVal(r, "Charges")));
      const adjustment = toNum(getVal(r, "Adjustment"));
      const g = {
        Insurance: normalizeInsurance(getVal(r, "Insurance")),
        CPT: String(getVal(r, "CPT") || "").trim(),
        POS: String(getVal(r, "POS") || "").trim(),
        Modifiers: normalizeModifiers(getVal(r, "Modifiers")),
        Units: String(
          getVal(r, "Days_or_Units") ||
            getVal(r, "Days_Or_Units") ||
            getVal(r, "Units") ||
            1
        ).trim(),
      };
      const patient = String(getVal(r, "Patient_Name") || "").trim();
      const dos = String(getVal(r, "Date_of_Service") || "").trim();
      return {
        _row: r,
        idx,
        patient,
        dos,
        allowed,
        insurancePaid,
        charges,
        adjustment,
        g,
        groupKey: buildKey(g),
      };
    });
}

export default function PaymentAnalyzerV6() {
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState([]);
  const [threshold, setThreshold] = useState(10); // default ±10%
  const [pasteText, setPasteText] = useState("");
  const [filter, setFilter] = useState({ payer: "", cpt: "", pos: "", mods: "" });
  const [decontaminateChargesProxy, setDecontaminateChargesProxy] = useState(true);
  const [examples, setExamples] = useState("");
  const [benchmark, setBenchmark] = useState("paid"); // 'paid' or 'allowed'
  const [overrides, setOverrides] = useState({}); // key -> number
  const [includeUnitsInKey, setIncludeUnitsInKey] = useState(false); // default false per user request

  // Persist overrides
  useEffect(() => {
    try {
      const saved = localStorage.getItem("ipa_overrides_v6");
      if (saved) setOverrides(JSON.parse(saved));
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("ipa_overrides_v6", JSON.stringify(overrides));
    } catch {}
  }, [overrides]);

  const onUpload = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = (evt) => setRows(parseText(String(evt.target?.result || "")));
    reader.readAsText(f);
  };

  const onPasteAnalyze = () => {
    if (!pasteText.trim()) return;
    setFileName("(pasted)");
    setRows(parseText(pasteText));
  };

  function buildGroups(enriched) {
    const stats = [];
    const groupsMap = new Map();

    const keyFor = (g) => (includeUnitsInKey ? buildKey(g) : buildKeyNoUnits(g));

    // Buckets
    const buckets = new Map();
    for (const d of enriched) {
      const k = keyFor(d.g);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(d);
    }

    for (const [key, items] of buckets.entries()) {
      const sample = items[0];
      const { Insurance, CPT, POS, Modifiers, Units } = sample.g;

      const metricAll = items.map((d) => (benchmark === "paid" ? d.insurancePaid : d.allowed));

      // Decontaminate "Allowed == Charges" when benchmarking allowed and group is mixed
      let metricForProxy = metricAll.slice();
      if (benchmark === "allowed") {
        const equalsChargesFlags = items.map((d) => Math.abs(d.allowed - d.charges) < 0.01);
        const hasEq = equalsChargesFlags.some(Boolean);
        const hasDiff = equalsChargesFlags.some((f) => !f);
        if (decontaminateChargesProxy && hasEq && hasDiff) {
          metricForProxy = items.filter((d, i) => !equalsChargesFlags[i]).map((d) => d.allowed);
        }
        if (metricForProxy.length === 0) metricForProxy = metricAll;
      }

      // Proxy selection: n<=2 -> max; else mode by freq; tie -> higher $ value
      let proxy = 0, method = "";
      const n = metricForProxy.length;
      const rounded = metricForProxy.map((v) => +(+v).toFixed(2));
      if (n <= 2) {
        proxy = d3.max(rounded) ?? 0;
        method = "max_when_few";
      } else {
        const freq = new Map();
        for (const v of rounded) freq.set(v, (freq.get(v) || 0) + 1);
        const entries = Array.from(freq.entries());
        entries.sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));
        proxy = entries[0]?.[0] ?? 0;
        const topCount = entries[0]?.[1] ?? 0;
        const secondCount = entries[1]?.[1] ?? 0;
        method = topCount === secondCount ? "mode (tie→max)" : "mode";
      }

      const median = d3.median(metricAll) ?? 0;
      const mean = d3.mean(metricAll) ?? 0;
      const min = d3.min(metricAll) ?? 0;
      const max = d3.max(metricAll) ?? 0;

      const equalsChargesCount = items.filter((d) => Math.abs(d.allowed - d.charges) < 0.01).length;

      const roundedAll = metricAll.map((v) => +(+v).toFixed(2));
      const freqAll = d3.rollup(roundedAll, (v) => v.length, (v) => v);
      const topValues = Array.from(freqAll.entries()).sort((a, b) => b[1] - a[1]);
      const multiModal = topValues.length > 1 && topValues[0][1] === topValues[1][1];
      const nearTie = topValues.length > 1 && topValues[1][1] / topValues[0][1] >= 0.6;

      // Apply override (respect grouping mode)
      const overrideKey = key;
      const override = overrides[overrideKey];
      if (override !== undefined && override !== null && !Number.isNaN(Number(override))) {
        proxy = +Number(override).toFixed(2);
        method = "override";
      }

      const stat = {
        key,
        Insurance,
        CPT,
        POS,
        Modifiers,
        Units,
        n: items.length,
        proxy,
        method,
        median,
        mean,
        min,
        max,
        nEqCharges: equalsChargesCount,
        usedDecontaminate: benchmark === "allowed" && decontaminateChargesProxy && equalsChargesCount > 0,
        topValues,
        multiModal,
        nearTie,
      };

      stats.push(stat);
      groupsMap.set(key, { items, stat });
    }

    stats.sort((a, b) => a.Insurance.localeCompare(b.Insurance) || a.CPT.localeCompare(b.CPT));
    return { stats, groupsMap };
  }

  // Manual override UI state
  const [ovrForm, setOvrForm] = useState({ payer: "", cpt: "", pos: "", mods: "", units: "1", amount: "" });
  const ovrKey = useMemo(() => {
    const g = {
      Insurance: normalizeInsurance(ovrForm.payer),
      CPT: String(ovrForm.cpt || "").trim(),
      POS: String(ovrForm.pos || "").trim(),
      Modifiers: normalizeModifiers(ovrForm.mods),
      Units: String(ovrForm.units || 1).trim(),
    };
    if (!g.Insurance || !g.CPT || !g.POS) return "";
    return includeUnitsInKey ? buildKey(g) : buildKeyNoUnits(g);
  }, [ovrForm, includeUnitsInKey]);

  const applyOverride = () => {
    if (!ovrKey) return;
    const amt = +Number(ovrForm.amount).toFixed(2);
    if (!Number.isFinite(amt)) return;
    setOverrides((m) => ({ ...m, [ovrKey]: amt }));
  };
  const clearOverride = () => {
    if (!ovrKey) return;
    setOverrides((m) => {
      const n = { ...m };
      delete n[ovrKey];
      return n;
    });
  };
  const resetOverridesAll = () => setOverrides({});

  function buildHover(stat) {
    const top = (stat.topValues || []).slice(0, 5).map(([v, c]) => `${fmt(v)}×${c}`).join(", ");
    const warn = stat.multiModal ? "⚠ multi‑modal (tie)" : stat.nearTie ? "⚠ near tie" : "";
    const cleaned = stat.usedDecontaminate ? " (cleaned)" : "";
    return `Method: ${stat.method}${cleaned}\nGroup n: ${stat.n}\nRange: ${fmt(stat.min)} – ${fmt(stat.max)}\nMedian: ${fmt(stat.median)}  Mean: ${fmt(stat.mean)}\nTop values: ${top}\n${warn}`;
  }

  // MAIN ANALYSIS
  const { issues, groupedStats, totals, denials, unpaidPatients, proxyAudits, groupsMap } = useMemo(() => {
    if (!rows.length) return { issues: [], groupedStats: [], totals: null, denials: [], unpaidPatients: [], proxyAudits: [], groupsMap: new Map() };

    const enriched = enrichRows(rows);
    const { stats, groupsMap } = buildGroups(enriched);

    const outIssues = [];
    const proxyAud = [];

    stats.forEach((stat) => {
      const pack = groupsMap.get(stat.key);
      const items = pack.items;

      items.forEach((d) => {
        const metric = benchmark === "paid" ? d.insurancePaid : d.allowed;
        const delta = percentDelta(metric, stat.proxy);
        const absDelta = Math.abs(delta);
        let label = "Within expected range";
        let reason = benchmark === "paid"
          ? "Paid aligns with proxy typical payment for same payer/CPT/POS/mods/units."
          : "Allowed aligns with proxy contracted rate.";

        if (absDelta > threshold) {
          if (delta < 0) {
            label = benchmark === "paid" ? "Underpaid" : "Underpayment";
            reason = benchmark === "paid"
              ? "Paid is below typical. Check missing modifier, bundling, site-of-service, or incorrect units."
              : "Allowed is below typical for same group.";
          } else {
            label = benchmark === "paid" ? "Overpaid" : "Overpayment";
            reason = benchmark === "paid"
              ? "Paid is above typical. Could be variant code, bilateral/bundle paid separately, or POS mismatch."
              : "Allowed is above typical.";
          }
        }

        // Proxy audit flags
        const usingChargesAsAllowed = Math.abs(d.allowed - d.charges) < 0.01 && d.charges > 0;
        const thinGroup = items.length <= 2;
        const suspiciousProxy = thinGroup || stat.proxy < 1;
        if ((label === "Overpaid" || label === "Overpayment") && (usingChargesAsAllowed || suspiciousProxy)) {
          proxyAud.push({
            Patient: d.patient,
            DOS: d.dos,
            Insurance: d.g.Insurance,
            CPT: d.g.CPT,
            POS: d.g.POS,
            Modifiers: d.g.Modifiers,
            Units: d.g.Units,
            Charges: d.charges,
            Metric: metric,
            Proxy: stat.proxy,
            nInGroup: items.length,
            Method: stat.method + (stat.usedDecontaminate ? " + decontaminated" : ""),
            Note: usingChargesAsAllowed
              ? "This line's Allowed equals Charges — older logic likely used CHARGES as benchmark."
              : thinGroup
              ? "Proxy built from ≤2 lines — unstable. Consider widening period or grouping."
              : "",
          });
        }

        outIssues.push({
          Patient: d.patient,
          DOS: d.dos,
          Insurance: d.g.Insurance,
          CPT: d.g.CPT,
          POS: d.g.POS,
          Modifiers: d.g.Modifiers,
          Units: d.g.Units,
          Charges: d.charges.toFixed(2),
          Metric: metric.toFixed(2),
          Proxy: stat.proxy.toFixed(2),
          ProxyHover: buildHover(stat),
          DeviationPct: `${delta.toFixed(1)}%`,
          Status: label,
          Explanation: reason,
        });
      });
    });

    // Denials (zero insurer payment with write-off OR zero metric when charges > 0)
    const enr = enrichRows(rows);
    const denials = enr
      .filter((d) => {
        const bal = Math.max(0, toNum(getVal(d._row, "Balance")));
        const approxWriteOff = d.charges > 0 && Math.abs(d.adjustment + d.charges) < 0.01 && d.insurancePaid === 0 && bal === 0;
        const metricZero = (benchmark === "paid" ? d.insurancePaid : d.allowed) === 0 && d.charges > 0;
        return approxWriteOff || metricZero;
      })
      .map((d) => ({
        Patient: d.patient,
        DOS: d.dos,
        Insurance: d.g.Insurance,
        CPT: d.g.CPT,
        POS: d.g.POS,
        Modifiers: d.g.Modifiers,
        Units: d.g.Units,
        Charges: d.charges.toFixed(2),
        InsurancePaid: d.insurancePaid.toFixed(2),
        Adjustment: d.adjustment.toFixed(2),
      }));

    // Patients with $0 insurer reimbursement
    const byPatient = d3.group(enr, (d) => d.patient);
    const unpaidPatients = Array.from(byPatient, ([patient, items]) => {
      const totalCharges = d3.sum(items, (d) => d.charges);
      const totalInsPaid = d3.sum(items, (d) => d.insurancePaid);
      const totalBalance = d3.sum(items, (d) => Math.max(0, toNum(getVal(d._row, "Balance"))));
      const totalAllowed = d3.sum(items, (d) => d.allowed);
      return {
        Patient: patient,
        InsuranceList: Array.from(new Set(items.map((d) => d.g.Insurance))).join(", "),
        TotalCharges: totalCharges,
        TotalInsurancePaid: totalInsPaid,
        TotalAllowed: totalAllowed,
        TotalBalance: totalBalance,
        AllZeroPaid: totalInsPaid === 0 && totalCharges > 0,
        UnpaidGap: Math.max(0, (benchmark === "paid" ? totalInsPaid : totalAllowed) - totalInsPaid),
      };
    })
      .filter((p) => p.AllZeroPaid)
      .sort((a, b) => b.UnpaidGap - a.UnpaidGap)
      .map((p) => ({
        Patient: p.Patient,
        Insurances: p.InsuranceList,
        TotalCharges: fmt(p.TotalCharges),
        TotalAllowed: fmt(p.TotalAllowed),
        TotalInsurancePaid: fmt(p.TotalInsurancePaid),
        TotalBalance: fmt(p.TotalBalance),
        UnpaidGap: fmt(p.UnpaidGap),
      }));

    const totals = {
      totalInsurancePaid: d3.sum(enr, (d) => d.insurancePaid),
      totalActual: d3.sum(enr, (d) => (benchmark === "paid" ? d.insurancePaid : d.allowed)),
      totalExpected: d3.sum(stats, (s) => s.proxy * s.n),
      deltaExpectedMinusActual:
        d3.sum(stats, (s) => s.proxy * s.n) - d3.sum(enr, (d) => (benchmark === "paid" ? d.insurancePaid : d.allowed)),
      benchmarkLabel: benchmark === "paid" ? "Paid" : "Allowed",
    };

    outIssues.sort((a, b) => {
      const aBad = a.Status !== "Within expected range";
      const bBad = b.Status !== "Within expected range";
      if (aBad !== bBad) return aBad ? -1 : 1;
      return Math.abs(parseFloat(b.DeviationPct)) - Math.abs(parseFloat(a.DeviationPct));
    });

    proxyAud.sort((a, b) => Math.abs((b.Metric || 0) - (b.Proxy || 0)) - Math.abs((a.Metric || 0) - (a.Proxy || 0)));

    return { issues: outIssues, groupedStats: stats, totals, denials, unpaidPatients, proxyAudits: proxyAud, groupsMap };
  }, [rows, threshold, decontaminateChargesProxy, benchmark, overrides, includeUnitsInKey]);

  const filteredIssues = useMemo(() => {
    return issues.filter((r) =>
      (!filter.payer || r.Insurance.toLowerCase().includes(filter.payer.toLowerCase())) &&
      (!filter.cpt || r.CPT.toString() === filter.cpt) &&
      (!filter.pos || r.POS.toString() === filter.pos) &&
      (!filter.mods || r.Modifiers.toLowerCase() === normalizeModifiers(filter.mods).toLowerCase())
    );
  }, [issues, filter]);

  const reset = () => {
    setFileName("");
    setRows([]);
    setPasteText("");
    setExamples("");
    setFilter({ payer: "", cpt: "", pos: "", mods: "" });
    setBenchmark("paid");
  };

  const downloadCSV = () => {
    const csv = Papa.unparse(issues);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payment_issues_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exampleResults = useMemo(() => {
    if (!examples.trim()) return [];
    const want = Papa.parse(examples, { header: true, skipEmptyLines: true, delimiter: "" }).data || [];

    let gm = groupsMap;
    if ((!gm || gm.size === 0) && examples.toUpperCase().includes("PATIENT_NAME") && examples.toUpperCase().includes("INSURANCE_PAYMENT")) {
      const tmpRows = enrichRows(parseText(examples));
      gm = buildGroups(tmpRows).groupsMap;
    }

    return want.map((r) => {
      const g = {
        Insurance: normalizeInsurance(r.Insurance),
        CPT: String(r.CPT || "").trim(),
        POS: String(r.POS || "").trim(),
        Modifiers: normalizeModifiers(r.Modifiers),
        Units: String(r.Units || 1).trim(),
      };
      const key = includeUnitsInKey ? buildKey(g) : buildKeyNoUnits(g);
      const pack = gm.get(key);
      if (!pack) {
        return {
          ...g,
          Found: false,
          Message: "No matching group in loaded data (payer/CPT/POS/mods/units). The old proxy likely came from a different grouping or time period.",
        };
      }
      const { stat, items } = pack;
      const metricVals = items.map((d) => (benchmark === "paid" ? d.insurancePaid : d.allowed)).map((v) => +(+v).toFixed(2));
      const freq = d3.rollup(metricVals, (v) => v.length, (v) => v);
      const top = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);

      return {
        ...g,
        Found: true,
        Proxy: stat.proxy.toFixed(2),
        Method: stat.method + (stat.usedDecontaminate ? " + decontaminated" : ""),
        n: stat.n,
        nEqCharges: stat.nEqCharges,
        Range: `${stat.min.toFixed(2)} – ${stat.max.toFixed(2)}`,
        TopValues: top.map(([val, c]) => `${val}×${c}`).join(", "),
        Message: stat.multiModal
          ? "⚠ multi‑modal distribution (tie)"
          : stat.nearTie
          ? "⚠ near tie in distribution"
          : stat.usedDecontaminate
          ? "Group had mixed lines (Allowed==Charges and others). We ignored equals‑charges lines when benchmarking Allowed."
          : "",
      };
    });
  }, [examples, groupsMap, benchmark, includeUnitsInKey]);

  return (
    <div className="p-4 space-y-4">
      {/* HEADER & UPLOAD */}
      <Card>
        <CardContent className="space-y-3">
          <h2 className="text-xl font-semibold">Insurance Payment Analyzer (v6)</h2>
          <p className="text-sm text-gray-600">
            Compares each line's <b>{benchmark === 'paid' ? 'Insurance Paid' : 'Allowed'}</b> to a proxy built from the distribution for the same
            payer × CPT × POS × modifiers {includeUnitsInKey ? '× units' : '(units ignored)'}.
            Hover a <b>Proxy</b> value to see <i>how it was derived</i> (method, n, range, top values). You can <b>override</b> any proxy below.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="flex items-center space-x-2">
              <Input type="file" accept=".csv,.tsv,.txt" onChange={onUpload} />
              <Button variant="secondary" onClick={reset}>
                <RefreshCw className="mr-2 h-4 w-4" /> Reset
              </Button>
            </div>
            <div className="flex items-center space-x-3">
              <Button onClick={onPasteAnalyze}>
                <ClipboardPaste className="mr-2 h-4 w-4" /> Analyze Pasted Text
              </Button>
              <div className="flex items-center space-x-2 w-full">
                <span className="text-sm text-gray-600">Variance threshold ±{threshold}%</span>
                <Slider value={[threshold]} onValueChange={(v) => setThreshold(v[0] ?? 10)} min={1} max={30} step={1} className="w-40" />
              </div>
            </div>
          </div>

          <Textarea
            placeholder="Paste your full report here (include the header row). Tabs or commas are fine."
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            className="min-h-[140px]"
          />

          {fileName && <p className="text-xs text-gray-500">Loaded: {fileName}</p>}

          <div className="flex flex-wrap items-center gap-4 text-sm text-gray-700">
            <label className="flex items-center gap-2">
              <input type="radio" name="benchmark" checked={benchmark === "paid"} onChange={() => setBenchmark("paid")} />
              Benchmark on <b>Insurance Paid</b>
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="benchmark" checked={benchmark === "allowed"} onChange={() => setBenchmark("allowed")} />
              Benchmark on Allowed (Ins+Pat+Bal)
            </label>
            {benchmark === "allowed" && (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={decontaminateChargesProxy} onChange={(e) => setDecontaminateChargesProxy(e.target.checked)} />
                Ignore lines where Allowed==Charges when group is mixed
              </label>
            )}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={includeUnitsInKey} onChange={(e) => setIncludeUnitsInKey(e.target.checked)} />
              Include <b>Units</b> in grouping key
            </label>
          </div>

          <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
            <li><b>Insurance Paid</b> is treated as absolute value of Insurance_Payment (negatives in source become positive).</li>
            <li>Grouping key: Insurance × CPT × POS × Modifiers {includeUnitsInKey ? '× Units' : '(Units ignored)'}. Modifiers are normalized. United payer aliases are merged.</li>
            <li>Proxy selection: <b>mode</b> by frequency (tie → <b>higher $</b>); n≤2 → <b>max</b>. Overrides supersede all.</li>
            <li>We never use <i>Charges</i> as a proxy. When benchmarking Allowed, optional decontamination prevents equals‑charges lines poisoning the proxy.</li>
          </ul>
        </CardContent>
      </Card>

      {/* QUICK FILTER */}
      <Card>
        <CardContent className="space-y-2">
          <h3 className="text-lg font-semibold">Quick Filter (inspect a specific group)</h3>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-2 items-end">
            <div>
              <label className="text-xs text-gray-500">Payer</label>
              <Input placeholder="e.g., Medicare - California (North)" value={filter.payer} onChange={(e) => setFilter({ ...filter, payer: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-gray-500">CPT</label>
              <Input placeholder="e.g., 11044" value={filter.cpt} onChange={(e) => setFilter({ ...filter, cpt: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-gray-500">POS</label>
              <Input placeholder="e.g., 21 or 11" value={filter.pos} onChange={(e) => setFilter({ ...filter, pos: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-gray-500">Modifiers</label>
              <Input placeholder="e.g., 59 or 59+79" value={filter.mods} onChange={(e) => setFilter({ ...filter, mods: e.target.value })} />
            </div>
            <div className="flex items-center">
              <Search className="h-4 w-4 mr-2" />
              <span className="text-sm text-gray-600">Results below honor these filters</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* MANUAL OVERRIDE */}
      <Card>
        <CardContent className="space-y-3">
          <h3 className="text-lg font-semibold">Manual Proxy Override</h3>
          <p className="text-sm text-gray-600">Set your own proxy for a specific group (payer×CPT×POS×mods{includeUnitsInKey ? '×units' : ''}). This instantly re‑evaluates all lines for that group.</p>
          <div className="grid grid-cols-1 md:grid-cols-6 gap-2">
            <Input placeholder="Payer" value={ovrForm.payer} onChange={(e) => setOvrForm({ ...ovrForm, payer: e.target.value })} />
            <Input placeholder="CPT" value={ovrForm.cpt} onChange={(e) => setOvrForm({ ...ovrForm, cpt: e.target.value })} />
            <Input placeholder="POS" value={ovrForm.pos} onChange={(e) => setOvrForm({ ...ovrForm, pos: e.target.value })} />
            <Input placeholder="Modifiers (e.g., 59+79 or —)" value={ovrForm.mods} onChange={(e) => setOvrForm({ ...ovrForm, mods: e.target.value })} />
            {includeUnitsInKey && (
              <Input placeholder="Units (default 1)" value={ovrForm.units} onChange={(e) => setOvrForm({ ...ovrForm, units: e.target.value })} />
            )}
            <Input placeholder="Override amount" value={ovrForm.amount} onChange={(e) => setOvrForm({ ...ovrForm, amount: e.target.value })} />
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={applyOverride} disabled={!ovrKey || !ovrForm.amount}>Apply override</Button>
            <Button variant="outline" onClick={clearOverride} disabled={!ovrKey}>Clear this override</Button>
            <Button variant="ghost" onClick={resetOverridesAll}><Undo2 className="h-4 w-4 mr-2" /> Clear ALL overrides</Button>
            {ovrKey && <span className="text-xs text-gray-500">Key: <code>{ovrKey}</code></span>}
          </div>
        </CardContent>
      </Card>

      {/* TOTALS */}
      {totals && (
        <Card>
          <CardContent>
            <h3 className="text-lg font-semibold mb-2">Totals</h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-sm">
              <div className="p-3 rounded-xl bg-gray-50">
                <div className="text-gray-500">Total Actually Paid by Insurance</div>
                <div className="text-xl font-semibold">${fmt(totals.totalInsurancePaid)}</div>
              </div>
              <div className="p-3 rounded-xl bg-gray-50">
                <div className="text-gray-500">Total {totals.benchmarkLabel} (Actual)</div>
                <div className="text-xl font-semibold">${fmt(totals.totalActual)}</div>
              </div>
              <div className="p-3 rounded-xl bg-gray-50">
                <div className="text-gray-500">Total {totals.benchmarkLabel} (Expected by Proxy)</div>
                <div className="text-xl font-semibold">${fmt(totals.totalExpected)}</div>
              </div>
              <div className="p-3 rounded-xl bg-gray-50">
                <div className="text-gray-500">Delta (Expected − Actual)</div>
                <div className="text-xl font-semibold">${fmt(totals.deltaExpectedMinusActual)}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ISSUES TABLE */}
      {!!issues.length && (
        <Card>
          <CardContent>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold">Line‑by‑line Review</h3>
              <Button size="sm" variant="outline" onClick={downloadCSV}>
                <Download className="h-4 w-4 mr-2" /> Export CSV
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-2">Patient</th>
                    <th className="text-left p-2">DOS</th>
                    <th className="text-left p-2">Insurance</th>
                    <th className="text-left p-2">CPT</th>
                    <th className="text-left p-2">POS</th>
                    <th className="text-left p-2">Mods</th>
                    <th className="text-right p-2">Charges</th>
                    <th className="text-right p-2">{benchmark === 'paid' ? 'Paid' : 'Allowed'}</th>
                    <th className="text-right p-2">Proxy</th>
                    <th className="text-right p-2">Δ%</th>
                    <th className="text-left p-2">Status</th>
                    <th className="text-left p-2">Explanation</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredIssues.map((r, i) => (
                    <tr key={i} className={`border-b ${r.Status !== "Within expected range" ? "bg-red-50/40" : ""}`}>
                      <td className="p-2 whitespace-nowrap">{r.Patient}</td>
                      <td className="p-2 whitespace-nowrap">{r.DOS}</td>
                      <td className="p-2 whitespace-nowrap">{r.Insurance}</td>
                      <td className="p-2 whitespace-nowrap">{r.CPT}</td>
                      <td className="p-2 whitespace-nowrap">{r.POS}</td>
                      <td className="p-2 whitespace-nowrap">{r.Modifiers}</td>
                      <td className="p-2 text-right">{r.Charges}</td>
                      <td className="p-2 text-right">{r.Metric}</td>
                      <td className="p-2 text-right" title={r.ProxyHover}>{r.Proxy}</td>
                      <td className="p-2 text-right">{r.DeviationPct}</td>
                      <td className="p-2 whitespace-nowrap font-medium">{r.Status}</td>
                      <td className="p-2 min-w-[280px]">{r.Explanation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* GROUPED BENCHMARKS */}
      {!!groupedStats.length && (
        <Card>
          <CardContent>
            <h3 className="text-lg font-semibold mb-2">Payer × CPT × POS × Modifiers {includeUnitsInKey ? '× Units' : ''} — Benchmarks</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-2">Insurance</th>
                    <th className="text-left p-2">CPT</th>
                    <th className="text-left p-2">POS</th>
                    <th className="text-left p-2">Mods</th>
                    <th className="text-left p-2">Units</th>
                    <th className="text-right p-2">n</th>
                    <th className="text-right p-2">Proxy</th>
                    <th className="text-left p-2">Method</th>
                    <th className="text-right p-2">Median</th>
                    <th className="text-right p-2">Mean</th>
                    <th className="text-right p-2">Min</th>
                    <th className="text-right p-2">Max</th>
                    <th className="text-right p-2">Eq Charges</th>
                    <th className="text-left p-2">Warn</th>
                  </tr>
                </thead>
                <tbody>
                  {groupedStats.map((g, i) => (
                    <tr key={i} className="border-b hover:bg-gray-50">
                      <td className="p-2 whitespace-nowrap">{g.Insurance}</td>
                      <td className="p-2 whitespace-nowrap">{g.CPT}</td>
                      <td className="p-2 whitespace-nowrap">{g.POS}</td>
                      <td className="p-2 whitespace-nowrap">{g.Modifiers}</td>
                      <td className="p-2 whitespace-nowrap">{g.Units}</td>
                      <td className="p-2 text-right">{g.n}</td>
                      <td className="p-2 text-right" title={buildHover(g)}>{g.proxy.toFixed(2)}</td>
                      <td className="p-2 whitespace-nowrap">{g.method}{g.usedDecontaminate ? " (cleaned)" : ""}</td>
                      <td className="p-2 text-right">{g.median.toFixed(2)}</td>
                      <td className="p-2 text-right">{g.mean.toFixed(2)}</td>
                      <td className="p-2 text-right">{g.min.toFixed(2)}</td>
                      <td className="p-2 text-right">{g.max.toFixed(2)}</td>
                      <td className="p-2 text-right">{g.nEqCharges}</td>
                      <td className="p-2 whitespace-nowrap">{g.multiModal ? "⚠ tie" : g.nearTie ? "⚠ near" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* PROXY AUDIT */}
      {!!proxyAudits.length && (
        <Card>
          <CardContent>
            <h3 className="text-lg font-semibold mb-2">Proxy Audit — potential false overpayments</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-2">Patient</th>
                    <th className="text-left p-2">DOS</th>
                    <th className="text-left p-2">Insurance</th>
                    <th className="text-left p-2">CPT</th>
                    <th className="text-left p-2">POS</th>
                    <th className="text-left p-2">Mods</th>
                    <th className="text-right p-2">Charges</th>
                    <th className="text-right p-2">{benchmark === 'paid' ? 'Paid' : 'Allowed'}</th>
                    <th className="text-right p-2">Proxy</th>
                    <th className="text-right p-2">Group n</th>
                    <th className="text-left p-2">Method</th>
                    <th className="text-left p-2">Why flagged</th>
                  </tr>
                </thead>
                <tbody>
                  {proxyAudits.map((r, i) => (
                    <tr key={i} className="border-b">
                      <td className="p-2 whitespace-nowrap">{r.Patient}</td>
                      <td className="p-2 whitespace-nowrap">{r.DOS}</td>
                      <td className="p-2 whitespace-nowrap">{r.Insurance}</td>
                      <td className="p-2 whitespace-nowrap">{r.CPT}</td>
                      <td className="p-2 whitespace-nowrap">{r.POS}</td>
                      <td className="p-2 whitespace-nowrap">{r.Modifiers}</td>
                      <td className="p-2 text-right">{fmt(r.Charges)}</td>
                      <td className="p-2 text-right">{fmt(r.Metric)}</td>
                      <td className="p-2 text-right">{fmt(r.Proxy)}</td>
                      <td className="p-2 text-right">{r.nInGroup}</td>
                      <td className="p-2 whitespace-nowrap">{r.Method}</td>
                      <td className="p-2 whitespace-nowrap">{r.Note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* DENIALS */}
      {!!denials.length && (
        <Card>
          <CardContent>
            <h3 className="text-lg font-semibold mb-2">Completely Denied / Written-off Lines</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-2">Patient</th>
                    <th className="text-left p-2">DOS</th>
                    <th className="text-left p-2">Insurance</th>
                    <th className="text-left p-2">CPT</th>
                    <th className="text-left p-2">POS</th>
                    <th className="text-left p-2">Mods</th>
                    <th className="text-right p-2">Charges</th>
                    <th className="text-right p-2">Ins. Paid</th>
                    <th className="text-right p-2">Adjustment</th>
                  </tr>
                </thead>
                <tbody>
                  {denials.map((r, i) => (
                    <tr key={i} className="border-b">
                      <td className="p-2 whitespace-nowrap">{r.Patient}</td>
                      <td className="p-2 whitespace-nowrap">{r.DOS}</td>
                      <td className="p-2 whitespace-nowrap">{r.Insurance}</td>
                      <td className="p-2 whitespace-nowrap">{r.CPT}</td>
                      <td className="p-2 whitespace-nowrap">{r.POS}</td>
                      <td className="p-2 whitespace-nowrap">{r.Modifiers}</td>
                      <td className="p-2 text-right">{r.Charges}</td>
                      <td className="p-2 text-right">{r.InsurancePaid}</td>
                      <td className="p-2 text-right">{r.Adjustment}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
          </div>
  );
}

