// The document a `form` interaction request is answered in. A harness (omp's
// `ask` tool) hands awui one semantic HTML `<form>`; the browser shows it in an
// opaque-origin frame, which collects the controls' values exactly as an HTML
// form submits them. The frame can reach neither the app's session nor its
// storage; it only posts the submitted data (or a cancel) to its parent.
//
// The page's own script is the one the server injects with a per-response
// nonce, so a `<script>` or inline handler inside the harness's form never runs.
// This module is pure: the server builds the document, the web client reads the
// messages, and tests exercise both without a browser.
import { HTML_RENDER_THEME_FRAGMENT, HTML_RENDER_THEME_MESSAGE } from "./html-render.js";
import type { InteractionFormData, InteractionFormValue } from "./protocol.js";

/** The frame's message when the person submits the form. */
export const INTERACTION_FORM_SUBMIT = "awui-interaction-form/submit";
/** The frame's message when the person dismisses it. */
export const INTERACTION_FORM_CANCEL = "awui-interaction-form/cancel";
/** The frame's message carrying its content height. */
export const INTERACTION_FORM_HEIGHT = "awui-interaction-form/height";

/** The frame's height limits: enough for a real form, never more than most of the view. */
export const INTERACTION_FORM_MIN_HEIGHT = 140;
export const INTERACTION_FORM_MAX_HEIGHT = 560;

export const clampInteractionFormHeight = (height: number): number =>
  Math.min(INTERACTION_FORM_MAX_HEIGHT, Math.max(INTERACTION_FORM_MIN_HEIGHT, Math.round(height)));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One submitted value, bounded as `interactionAnswerSchema` bounds it; anything else is not a value. */
function formValue(value: unknown): InteractionFormValue | undefined {
  if (typeof value === "string") return value.slice(0, 100_000);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length <= 1_000 && value.every((entry) => typeof entry === "string")) {
    return value.map((entry) => (entry as string).slice(0, 10_000));
  }
  return undefined;
}

/** The submitted data a frame posted, or null for any other message. */
export function readInteractionFormSubmit(data: unknown): InteractionFormData | null {
  if (!isRecord(data) || data.method !== INTERACTION_FORM_SUBMIT || !isRecord(data.data)) return null;
  const out: InteractionFormData = Object.create(null) as InteractionFormData;
  let count = 0;
  for (const [name, raw] of Object.entries(data.data)) {
    if (count >= 500) break;
    if (name === "" || name.length > 200) continue;
    const value = formValue(raw);
    if (value === undefined) continue;
    out[name] = value;
    count += 1;
  }
  return out;
}

/** Whether a frame posted a dismissal. */
export const readInteractionFormCancel = (data: unknown): boolean =>
  isRecord(data) && data.method === INTERACTION_FORM_CANCEL;

/** The content height a frame reported, or undefined for any other message. */
export function readInteractionFormHeight(data: unknown): number | undefined {
  if (!isRecord(data) || data.method !== INTERACTION_FORM_HEIGHT) return undefined;
  return typeof data.height === "number" && Number.isFinite(data.height) && data.height > 0 ? data.height : undefined;
}

// The frame's own styles. The form's own elements lay out inside this; the
// harness contract keeps styles and scripts out of the HTML it sends.
const FORM_CSS = `
:root{color-scheme:dark;--bg:#15171c;--surface:#1d2027;--surface-2:#242832;--border:#343a46;--text:#e6e8ee;--text-2:#b5bac7;--muted:#858c9c;--accent:#5b8cff;--accent-fg:#fff;--font-sans:system-ui,-apple-system,"Segoe UI",sans-serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,monospace}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--font-sans);font-size:14px;line-height:1.45;padding:10px 12px 12px}
form{display:flex;flex-direction:column;gap:8px}
p{margin:0 0 6px}
fieldset{margin:8px 0;padding:8px 10px;border:1px solid var(--border);border-radius:8px}
legend{padding:0 4px;color:var(--text-2);font-weight:600}
label{display:flex;align-items:flex-start;gap:7px;margin:3px 0;cursor:pointer}
label>input[type=radio],label>input[type=checkbox]{margin:3px 0 0;accent-color:var(--accent)}
input:not([type=radio]):not([type=checkbox]),select,textarea{background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:5px 8px;font:inherit;max-width:100%}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
textarea{min-height:64px;resize:vertical;width:100%}
pre{background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:8px;overflow:auto}
code{font-family:var(--font-mono)}
table{border-collapse:collapse}
th,td{border:1px solid var(--border);padding:3px 6px;text-align:left}
img{max-width:100%;height:auto}
.awui-other{display:flex;align-items:center;gap:8px;margin:2px 0 6px 22px;color:var(--text-2)}
.awui-other input{flex:1}
.awui-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid var(--border)}
.awui-actions button{border:1px solid var(--border);border-radius:6px;padding:6px 14px;font:inherit;font-weight:600;cursor:pointer;background:var(--surface-2);color:var(--text)}
.awui-actions button[type=submit]{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.awui-actions button:disabled{opacity:.6;cursor:default}
`;

// The frame's script: apply the host theme, offer Submit/Cancel (the form's
// own buttons are outside the harness contract), and post control values by
// name. A checkbox group of two or more is an array, a lone checkbox its value
// when checked, a number/range input a number when it parses, and every text
// control its text — the shape omp's form validation expects.
const FORM_SCRIPT = `(function(){
var FRAG=${JSON.stringify(HTML_RENDER_THEME_FRAGMENT)};
var THEME=${JSON.stringify(HTML_RENDER_THEME_MESSAGE)};
var SUBMIT=${JSON.stringify(INTERACTION_FORM_SUBMIT)};
var CANCEL=${JSON.stringify(INTERACTION_FORM_CANCEL)};
var HEIGHT=${JSON.stringify(INTERACTION_FORM_HEIGHT)};
function post(message){try{parent.postMessage(message,"*");}catch(e){}}
function applyTheme(t){
  if(!t||typeof t!=="object"||!t.variables)return;
  var root=document.documentElement;
  if(t.appearance==="light"||t.appearance==="dark")root.style.colorScheme=t.appearance;
  for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))root.style.setProperty(k,String(t.variables[k]).replace(/[;{}<>]/g,""));}
}
try{
  var m=new RegExp("[#&]"+FRAG+"=([^&]*)").exec(location.hash);
  if(m){applyTheme(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}
}catch(e){}
window.addEventListener("message",function(e){
  var d=e.data;
  if(d&&typeof d==="object"&&d.method===THEME)applyTheme(d.theme);
});
function reportHeight(){
  var body=document.body,html=document.documentElement;
  var h=Math.ceil(Math.max(body?body.scrollHeight:0,html?html.scrollHeight:0));
  if(h>0)post({method:HEIGHT,height:h});
}
if(typeof ResizeObserver!=="undefined")new ResizeObserver(reportHeight).observe(document.documentElement);
window.addEventListener("load",reportHeight);reportHeight();

function start(){
var form=document.querySelector("form");
if(!form)return;
var controls=[],byName=new Map(),others=new Map();
function collect(){
  controls=[];byName=new Map();
  for(var i=0;i<form.elements.length;i++){
    var el=form.elements[i];
    if(!el.name||el.disabled)continue;
    var tag=el.tagName;
    if(tag!=="INPUT"&&tag!=="SELECT"&&tag!=="TEXTAREA")continue;
    if(tag==="INPUT"&&/^(button|submit|reset|image|file)$/i.test(el.type))continue;
    controls.push(el);
    var list=byName.get(el.name);
    if(!list){list=[];byName.set(el.name,list);}
    list.push(el);
  }
}
function labelText(el){
  var label=el.closest&&el.closest("label");
  var text=label?label.textContent:(el.getAttribute("aria-label")||"");
  return (text||"").replace(/\\s+/g," ").trim();
}
// Radio and checkbox groups of two or more offer a free-text Other answer,
// unless one of their own options is labelled Other.
function addOthers(){
  byName.forEach(function(list,name){
    var first=list[0];
    if(first.tagName!=="INPUT")return;
    var choice=first.type==="radio"||first.type==="checkbox";
    if(!choice||list.length<2)return;
    if(list.some(function(el){return /^\\s*other\\b/i.test(labelText(el));}))return;
    var wrap=document.createElement("div");wrap.className="awui-other";
    var label=document.createElement("label");
    var input=document.createElement("input");
    input.type="text";input.placeholder="Other (type your own)";input.setAttribute("aria-label","Other answer for "+name);
    label.appendChild(document.createTextNode("Other"));label.appendChild(input);
    wrap.appendChild(label);
    var last=list[list.length-1];
    var anchor=last.closest&&last.closest("label")||last;
    (anchor.parentNode||form).insertBefore(wrap,anchor.nextSibling);
    others.set(name,input);
    // Typing an Other answer stands in for a radio group's choice, so the
    // browser's own required rule must not demand a radio as well; clearing it
    // restores the rule the form declared.
    list.forEach(function(el){if(el.required)el.setAttribute("data-required","1");});
    input.addEventListener("input",function(){
      var typed=input.value.trim()!=="";
      // Checkbox groups are validated as a group (see validGroups), never by
      // each box's own required flag.
      if(first.type!=="radio")return;
      list.forEach(function(el){el.required=typed?false:(el.getAttribute("data-required")==="1");});
    });
  });
  // A checkbox group's required rule is "at least one", not every checkbox.
  byName.forEach(function(list){
    if(list.length<2||list[0].type!=="checkbox")return;
    list.forEach(function(el){if(el.required){el.setAttribute("data-required","1");el.required=false;}});
    // A failed submit left "Select at least one" on the first box; picking any
    // box must clear it, or the browser blocks every later submit before this
    // page can hear it.
    list.forEach(function(el){el.addEventListener("change",function(){list.forEach(function(other){if("setCustomValidity" in other)other.setCustomValidity("");});});});
  });
}
function numeric(el){return el.tagName==="INPUT"&&(el.type==="number"||el.type==="range");}
function textValue(el){
  var text=el.value==null?"":String(el.value);
  if(numeric(el)&&text.trim()!==""){var n=Number(text);if(Number.isFinite(n))return n;}
  return text;
}
function buildData(){
  var data=Object.create(null);
  controls.forEach(function(el){if(el.type==="hidden")data[el.name]=el.value;});
  byName.forEach(function(list,name){
    var first=list[0];
    if(first.type==="hidden")return;
    if(first.tagName==="SELECT"){
      var selected=[];for(var i=0;i<first.selectedOptions.length;i++)selected.push(first.selectedOptions[i].value);
      data[name]=first.multiple&&first.options.length>1?selected:(selected.length?selected[0]:"");
      return;
    }
    if(first.tagName==="TEXTAREA"||(first.tagName==="INPUT"&&first.type!=="radio"&&first.type!=="checkbox")){
      data[name]=textValue(first);return;
    }
    var other=others.get(name);
    var typed=other?other.value.trim():"";
    if(first.type==="radio"){
      if(typed!==""){data[name]=typed;return;}
      var checked=list.find(function(el){return el.checked;});
      if(checked)data[name]=checked.value;
      return;
    }
    var values=list.filter(function(el){return el.checked;}).map(function(el){return el.value;});
    if(list.length>1){
      data[name]=typed!==""?values.concat(typed):values;
      return;
    }
    if(typed!==""){data[name]=typed;return;}
    if(values.length)data[name]=values[0];
  });
  return data;
}
function validGroups(){
  var ok=true;
  controls.forEach(function(el){if("setCustomValidity" in el)el.setCustomValidity("");});
  // omp treats a whitespace-only answer as empty; the browser's own required
  // rule does not, so a required text field says so before the data leaves.
  controls.forEach(function(el){
    if(el.type==="hidden"||el.type==="radio"||el.type==="checkbox"||el.tagName==="SELECT")return;
    if(el.required&&el.value.trim()===""){el.setCustomValidity("Required");ok=false;}
  });
  byName.forEach(function(list,name){
    if(list.length<2||list[0].type!=="checkbox")return;
    var required=list.some(function(el){return el.getAttribute("data-required")==="1";});
    var other=others.get(name);
    if(!required||list.some(function(el){return el.checked;})||(other&&other.value.trim()!==""))return;
    if("setCustomValidity" in list[0])list[0].setCustomValidity("Select at least one");
    ok=false;
  });
  return ok;
}
collect();
controls.forEach(function(el){
  if(el.tagName==="TEXTAREA"||(el.tagName==="INPUT"&&!/^(radio|checkbox|hidden|button|submit|reset|image|file)$/i.test(el.type)))el.addEventListener("input",function(){el.setCustomValidity("");});
});
addOthers();
var actions=document.createElement("div");actions.className="awui-actions";
var cancel=document.createElement("button");cancel.type="button";cancel.textContent="Cancel";
cancel.addEventListener("click",function(){post({method:CANCEL});});
var submit=document.createElement("button");submit.type="submit";submit.textContent="Submit";
actions.appendChild(cancel);actions.appendChild(submit);form.appendChild(actions);
form.addEventListener("submit",function(event){
  event.preventDefault();
  if(!validGroups()){form.reportValidity();return;}
  if(!form.checkValidity()){form.reportValidity();return;}
  post({method:SUBMIT,data:buildData()});
});
}
// The form's markup has to exist before controls are read or a button is added.
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
})();`;

/**
 * The whole document served for one `form` request: the harness's `<form>` in
 * the body, then the frame's own script (the styles are in the head). `nonce`
 * is the response's one script/style permit; anything else in the harness's
 * HTML runs nothing.
 */
export function interactionFormDocument(html: string, nonce: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style nonce="${nonce}">${FORM_CSS}</style></head><body>${html}<script nonce="${nonce}">${FORM_SCRIPT}</script></body></html>`;
}
