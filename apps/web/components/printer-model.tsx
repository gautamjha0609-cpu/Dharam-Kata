"use client";
import { Select } from "@/components/ios";
import { environmentFor, getModel, modelsByMake, partsLabel } from "@dk/print-template";

const FAMILY: Record<string, string> = { dotmatrix9: "9-pin dot-matrix", dotmatrix24: "24-pin dot-matrix", laser: "Laser (single sheets)", thermal: "Thermal", other: "Other" };

/** Model dropdown (grouped by make) + the environment that is applied automatically when a model is chosen. */
export function PrinterModelPicker({ value, onChange, id }: { value: string; onChange: (key: string) => void; id: string }) {
  const model = getModel(value);
  const env = environmentFor(model);
  return (
    <div className="space-y-2">
      <label className="label" htmlFor={id}>Printer make &amp; model</label>
      <Select id={id} className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose the model…</option>
        {modelsByMake().map(([make, list]) => (
          <optgroup key={make} label={make}>
            {list.map((p) => <option key={p.key} value={p.key}>{p.model}{p.verified ? "" : " (specs unconfirmed)"}</option>)}
          </optgroup>
        ))}
      </Select>
      {model && (
        <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
          <p className="font-semibold text-navy">Environment applied for {model.make} {model.model}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-700">
            <li>Type: {FAMILY[model.family]}{model.pins ? `, ${model.pins} pins` : ""}{model.columns ? `, ${model.columns} columns` : ""}</li>
            <li>Multi-part forms: {model.family === "laser" || model.family === "thermal" ? "none — it cannot make carbon copies (set “Copies” in the layout to print duplicates)" : partsLabel(model)}</li>
            <li>Preferred smallest text: <b>{env.preferredMinPt} pt</b> (the preview warns if text would print smaller)</li>
            <li>Recommended font: <b>{env.fontFamily}</b></li>
          </ul>
          {!model.verified && <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-amber-900">Specs for this model could not be confirmed. {model.note}</p>}
          {model.verified && model.note && <p className="mt-2 text-slate-600">{model.note}</p>}
          <details className="mt-2">
            <summary className="cursor-pointer font-medium text-navy">Windows set-up steps for this printer type</summary>
            <ol className="mt-1 list-decimal space-y-1 pl-5 text-slate-700">{env.driverSteps.map((s) => <li key={s}>{s}</li>)}</ol>
          </details>
          <p className="mt-2 text-xs text-slate-600">Listed models are not “supported” until the on-site checklist passes on your exact printer and driver.</p>
        </div>
      )}
    </div>
  );
}
