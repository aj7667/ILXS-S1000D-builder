import React, { useState, useEffect, useRef, useCallback } from "react";
import { Upload, ChevronRight, ChevronDown, Plus, Trash2, Download, Settings, X, AlertCircle, FileCode, Copy, Check, ShieldCheck } from "lucide-react";

// ---------------- XSD Parser ----------------
// Parses an XSD into a lookup of global elements, complexTypes, simpleTypes,
// attributes, attributeGroups, and groups. Resolution is done lazily at render time.

function parseXSD(xsdText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xsdText, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error("Invalid XSD: " + err.textContent.slice(0, 200));

  const XS = "http://www.w3.org/2001/XMLSchema";
  const root = doc.documentElement;

  const store = {
    elements: {},        // name -> {name, type, ref}
    complexTypes: {},     // name -> node
    simpleTypes: {},      // name -> {base, enums, pattern, maxInclusive}
    attributes: {},       // name -> {name, type, default}
    attributeGroups: {},  // name -> node
    groups: {},           // name -> node
    rootElement: null,
    targetNamespace: root.getAttribute("targetNamespace") || "",
  };

  const localName = (n) => n.localName || n.nodeName.replace(/^.*:/, "");
  const stripPrefix = (s) => (s ? s.replace(/^.*:/, "") : s);

  function getAnnotationDoc(node) {
    for (const c of node.children) {
      if (localName(c) === "annotation") {
        const d = Array.from(c.children).find((x) => localName(x) === "documentation");
        if (d) return d.textContent.trim();
      }
    }
    return null;
  }

  // Parse simpleType -> restriction info
  function parseSimpleType(node) {
    const info = { base: null, enums: [], pattern: null, maxInclusive: null, minInclusive: null };
    for (const c of node.children) {
      if (localName(c) === "restriction") {
        info.base = stripPrefix(c.getAttribute("base"));
        for (const r of c.children) {
          const ln = localName(r);
          if (ln === "enumeration") info.enums.push(r.getAttribute("value"));
          else if (ln === "pattern") info.pattern = r.getAttribute("value");
          else if (ln === "maxInclusive") info.maxInclusive = r.getAttribute("value");
          else if (ln === "minInclusive") info.minInclusive = r.getAttribute("value");
        }
      }
    }
    return info;
  }

  // First pass: index everything global
  for (const node of Array.from(root.children)) {
    const ln = localName(node);
    const name = node.getAttribute("name");
    if (ln === "element" && name) {
      store.elements[name] = {
        name,
        type: stripPrefix(node.getAttribute("type")),
        node,
      };
      const docu = getAnnotationDoc(root);
      if (docu && docu.includes("Root element:")) {
        const m = docu.match(/Root element:\s*(\w+)/);
        if (m) store.rootElement = m[1];
      }
    } else if (ln === "complexType" && name) {
      store.complexTypes[name] = node;
    } else if (ln === "simpleType" && name) {
      store.simpleTypes[name] = parseSimpleType(node);
    } else if (ln === "attribute" && name) {
      store.attributes[name] = {
        name,
        type: stripPrefix(node.getAttribute("type")),
        default: node.getAttribute("default"),
        node,
      };
    } else if (ln === "attributeGroup" && name) {
      store.attributeGroups[name] = node;
    } else if (ln === "group" && name) {
      store.groups[name] = node;
    }
  }

  // Find root element from annotation documentation
  const annos = doc.getElementsByTagNameNS(XS, "documentation");
  for (const a of annos) {
    const m = a.textContent.match(/Root element:\s*(\w+)/);
    if (m && store.elements[m[1]]) { store.rootElement = m[1]; break; }
  }
  if (!store.rootElement) {
    // fallback: first global element
    store.rootElement = Object.keys(store.elements)[0];
  }

  store._localName = localName;
  store._stripPrefix = stripPrefix;
  return store;
}

// ---------------- Schema resolution helpers ----------------
// Given the store, resolve an element's allowed attributes and children.

function getElementType(store, elName) {
  const el = store.elements[elName];
  if (!el) return null;
  return el.type || null;
}

// Resolve attribute definition: returns {name, type, use, default, enums, pattern, base}
function resolveAttribute(store, attrNode) {
  const ln = store._localName(attrNode);
  const strip = store._stripPrefix;
  if (ln !== "attribute") return null;

  let name = attrNode.getAttribute("name");
  let ref = attrNode.getAttribute("ref");
  let typeName = strip(attrNode.getAttribute("type"));
  const use = attrNode.getAttribute("use") || "optional";
  let def = attrNode.getAttribute("default");

  if (ref) {
    const refName = strip(ref);
    const globalAttr = store.attributes[refName];
    if (globalAttr) {
      name = globalAttr.name;
      typeName = globalAttr.type;
      if (def == null) def = globalAttr.default;
    } else {
      // external (e.g. xlink:, rdf:) — not in this schema
      return { name: ref, external: true, use, default: def, enums: [], pattern: null, base: "xs:string" };
    }
  }

  // resolve simpleType for enums/pattern
  let enums = [], pattern = null, base = typeName;
  if (typeName && store.simpleTypes[typeName]) {
    const st = store.simpleTypes[typeName];
    enums = st.enums;
    pattern = st.pattern;
    base = st.base;
  }
  return { name, type: typeName, use, default: def, enums, pattern, base, external: false };
}

// Collect attributes from a complexType node (including attributeGroups, recursively)
function collectAttributes(store, typeNode, seen = new Set()) {
  const out = [];
  if (!typeNode) return out;
  const ln = store._localName;

  function walk(node) {
    for (const c of Array.from(node.children)) {
      const cl = ln(c);
      if (cl === "attribute") {
        const a = resolveAttribute(store, c);
        if (a) out.push(a);
      } else if (cl === "attributeGroup") {
        const ref = store._stripPrefix(c.getAttribute("ref"));
        if (ref && store.attributeGroups[ref] && !seen.has(ref)) {
          seen.add(ref);
          walk(store.attributeGroups[ref]);
        } else if (ref && !store.attributeGroups[ref]) {
          // external attribute group (xlink) -> single free-text placeholder
          out.push({ name: ref, external: true, use: "optional", enums: [], pattern: null, base: "xs:string" });
        }
      } else if (cl === "simpleContent") {
        const ext = Array.from(c.children).find((x) => ln(x) === "extension");
        if (ext) walk(ext);
      } else if (cl === "complexContent") {
        const ext = Array.from(c.children).find((x) => ln(x) === "extension" || ln(x) === "restriction");
        if (ext) walk(ext);
      }
    }
  }
  walk(typeNode);
  // dedupe by name
  const map = new Map();
  for (const a of out) if (!map.has(a.name)) map.set(a.name, a);
  return Array.from(map.values());
}

// Does a complexType (or element) carry text content? (mixed or simpleContent)
function typeHasText(store, typeName) {
  if (!typeName) return false;
  const ct = store.complexTypes[typeName];
  if (ct) {
    if (ct.getAttribute("mixed") === "true") return true;
    const hasSimple = Array.from(ct.children).some((c) => store._localName(c) === "simpleContent");
    return hasSimple;
  }
  // primitive / simpleType backed element -> text
  if (store.simpleTypes[typeName]) return true;
  if (typeName.startsWith("xs:")) return true;
  return false;
}

// Returns list of {name, minOccurs, maxOccurs, choiceGroup, choiceMin, external}
// choiceMin = the minOccurs of the enclosing xs:choice itself (1 if not in a choice).
function collectChildren(store, typeNode, seen = new Set()) {
  const out = [];
  if (!typeNode) return out;
  const ln = store._localName;
  const strip = store._stripPrefix;
  let choiceCounter = 0;

  function walk(node, choiceId, inheritedMin, choiceMin, parentChoice) {
    for (const c of Array.from(node.children)) {
      const cl = ln(c);
      if (cl === "element") {
        const ref = c.getAttribute("ref");
        const nm = ref ? strip(ref) : c.getAttribute("name");
        const ownMin = c.getAttribute("minOccurs") == null ? 1 : parseInt(c.getAttribute("minOccurs"));
        out.push({
          name: nm,
          minOccurs: Math.min(ownMin, inheritedMin),
          maxOccurs: c.getAttribute("maxOccurs") === "unbounded" ? Infinity : (c.getAttribute("maxOccurs") == null ? 1 : parseInt(c.getAttribute("maxOccurs"))),
          choiceGroup: choiceId,
          choiceMin: choiceMin,
          parentChoice: parentChoice,
          external: ref ? !store.elements[nm] : false,
        });
      } else if (cl === "sequence") {
        const seqMin = c.getAttribute("minOccurs") == null ? 1 : parseInt(c.getAttribute("minOccurs"));
        walk(c, choiceId, Math.min(inheritedMin, seqMin), choiceMin, parentChoice);
      } else if (cl === "choice") {
        const myChoice = "choice_" + (choiceCounter++);
        const cMin = c.getAttribute("minOccurs") == null ? 1 : parseInt(c.getAttribute("minOccurs"));
        // nested choice remembers the choice it sits inside (choiceId), so the
        // validator can treat it as satisfied if a sibling branch was chosen instead
        walk(c, myChoice, Math.min(inheritedMin, cMin), Math.min(choiceMin, cMin), choiceId);
      } else if (cl === "group") {
        const ref = strip(c.getAttribute("ref"));
        const grpMin = c.getAttribute("minOccurs") == null ? 1 : parseInt(c.getAttribute("minOccurs"));
        if (ref && store.groups[ref] && !seen.has(ref)) {
          seen.add(ref);
          walk(store.groups[ref], choiceId, Math.min(inheritedMin, grpMin), Math.min(choiceMin, grpMin), parentChoice);
          seen.delete(ref);
        }
      } else if (cl === "complexContent" || cl === "simpleContent") {
        const ext = Array.from(c.children).find((x) => ln(x) === "extension" || ln(x) === "restriction");
        if (ext) walk(ext, choiceId, inheritedMin, choiceMin, parentChoice);
      }
    }
  }
  walk(typeNode, null, 1, 1, null);
  return out;
}

// ---------------- XML model node ----------------
let UID = 0;
function makeNode(store, elName) {
  const typeName = getElementType(store, elName);
  const attrs = collectAttributes(store, store.complexTypes[typeName]);
  const node = {
    uid: ++UID,
    name: elName,
    typeName,
    attributes: {},   // attrName -> value
    text: "",
    children: [],     // child model nodes
    hasText: typeHasText(store, typeName),
    _attrDefs: attrs,
    expanded: true,
  };
  // pre-seed default attribute values
  for (const a of attrs) {
    if (a.default != null) node.attributes[a.name] = a.default;
  }
  return node;
}

// Build a required skeleton recursively (with depth guard for recursive types)
function buildSkeleton(store, elName, depth, typeStack) {
  const node = makeNode(store, elName);
  const typeName = node.typeName;
  if (depth > 40) return node;
  // guard recursion: don't auto-expand a type already on the stack
  const stack = typeStack || [];
  const children = collectChildren(store, store.complexTypes[typeName]);
  // group by choiceGroup so we only build first option of a choice
  const handledChoices = new Set();
  for (const ch of children) {
    if (ch.external) continue;
    if (ch.choiceGroup) {
      if (handledChoices.has(ch.choiceGroup)) continue;
      handledChoices.add(ch.choiceGroup);
      if (ch.choiceMin < 1) continue; // optional choice — don't auto-build
      // build only the first option of a required choice
    } else {
      if (ch.minOccurs < 1) continue; // optional — only build required
    }
    if (stack.includes(ch.name)) continue; // avoid infinite recursion
    const childNode = buildSkeleton(store, ch.name, depth + 1, [...stack, elName]);
    node.children.push(childNode);
  }
  return node;
}

// Returns ordered list of allowed child element names (schema declaration order)
function childOrder(store, typeName) {
  const kids = collectChildren(store, store.complexTypes[typeName]);
  const order = [];
  for (const k of kids) if (!order.includes(k.name)) order.push(k.name);
  return order;
}

// Reorder a node's children to match schema sequence (stable within same name)
function orderedChildren(store, node) {
  const order = childOrder(store, node.typeName);
  if (!order.length) return node.children;
  const idx = (nm) => { const i = order.indexOf(nm); return i === -1 ? 9999 : i; };
  return [...node.children]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (idx(a.c.name) - idx(b.c.name)) || (a.i - b.i))
    .map((x) => x.c);
}

// ---------------- XML serialization ----------------
function escapeXML(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function serializeNode(node, indent, store, isRoot) {
  const pad = "  ".repeat(indent);
  const attrStrs = Object.entries(node.attributes)
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `${k}="${escapeXML(v)}"`);
  let rootNS = "";
  if (isRoot) {
    rootNS = ` xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"`;
  }
  const attrPart = attrStrs.length ? " " + attrStrs.join(" ") : "";
  const open = `<${node.name}${rootNS}${attrPart}`;

  const hasChildren = node.children.length > 0;
  const hasText = node.text && node.text.trim() !== "";

  if (!hasChildren && !hasText) {
    return `${pad}${open}/>`;
  }
  if (!hasChildren && hasText) {
    return `${pad}${open}>${escapeXML(node.text)}</${node.name}>`;
  }
  let inner = "";
  if (hasText) inner += `\n${pad}  ${escapeXML(node.text)}`;
  for (const c of orderedChildren(store, node)) {
    inner += "\n" + serializeNode(c, indent + 1, store, false);
  }
  return `${pad}${open}>${inner}\n${pad}</${node.name}>`;
}

function serializeDoc(node, store, enforceOrder) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n` + serializeNode(node, 0, store, true, enforceOrder);
}

// ---------------- Validation ----------------
function validateAttr(def, value) {
  if (value === "" || value == null) {
    if (def.use === "required") return "Required";
    return null;
  }
  if (def.enums && def.enums.length && !def.enums.includes(value)) {
    return "Must be one of the allowed values";
  }
  if (def.pattern) {
    try {
      const re = new RegExp("^(?:" + def.pattern + ")$");
      if (!re.test(value)) return "Does not match pattern: " + def.pattern;
    } catch (e) { /* ignore bad pattern */ }
  }
  const b = def.base || "";
  if (b.includes("nonNegativeInteger") || b.includes("positiveInteger") || b.includes("integer") || b.includes("int")) {
    if (!/^-?\d+$/.test(value)) return "Must be an integer";
    if (b.includes("nonNegative") && parseInt(value) < 0) return "Must be ≥ 0";
    if (b.includes("positive") && parseInt(value) <= 0) return "Must be > 0";
  }
  return null;
}

// ---------------- Import existing XML into model tree ----------------
function importXML(store, xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error("Invalid XML: " + err.textContent.slice(0, 200));
  const rootEl = doc.documentElement;

  function convert(domEl) {
    const name = domEl.localName || domEl.nodeName.replace(/^.*:/, "");
    const node = makeNode(store, name);
    // attributes
    for (const at of Array.from(domEl.attributes)) {
      const an = at.name;
      if (an.startsWith("xmlns")) continue;
      node.attributes[an] = at.value;
    }
    // children: elements vs text
    let textBuf = "";
    for (const c of Array.from(domEl.childNodes)) {
      if (c.nodeType === 3) {
        textBuf += c.nodeValue;
      } else if (c.nodeType === 1) {
        node.children.push(convert(c));
      }
    }
    if (node.hasText) {
      const t = textBuf.trim();
      if (t) node.text = t;
    }
    node.expanded = true;
    return node;
  }
  return convert(rootEl);
}

// ---------------- React UI ----------------
// ---------------- Document validation ----------------
function validateDocument(store, root) {
  const issues = [];
  function walk(node, path) {
    const here = path + "/" + node.name;
    // required attributes + value validity
    for (const d of node._attrDefs) {
      const v = node.attributes[d.name] || "";
      const e = validateAttr(d, v);
      if (e) issues.push({ path: here, uid: node.uid, kind: "attribute", msg: `@${d.name}: ${e}` });
    }
    // required children present?
    const allowed = collectChildren(store, store.complexTypes[node.typeName]).filter((c) => !c.external);
    const counts = {};
    for (const c of node.children) counts[c.name] = (counts[c.name] || 0) + 1;
    const handledChoices = new Set();
    for (const ch of allowed) {
      if (ch.choiceGroup) {
        if (handledChoices.has(ch.choiceGroup)) continue;
        handledChoices.add(ch.choiceGroup);
        if (ch.choiceMin < 1) continue; // optional choice
        const opts = allowed.filter((x) => x.choiceGroup === ch.choiceGroup);
        const has = opts.some((o) => (counts[o.name] || 0) > 0);
        if (has) continue;
        // If this choice is nested inside a parent choice, it's only required when
        // the parent choice's branch was actually taken. If any element belonging to
        // the parent choice (but outside this nested one) is present, a sibling branch
        // was chosen, so this nested choice does not apply.
        if (ch.parentChoice) {
          const parentMembers = allowed.filter((x) => x.choiceGroup === ch.parentChoice && x.choiceGroup !== ch.choiceGroup);
          const siblingChosen = parentMembers.some((o) => (counts[o.name] || 0) > 0);
          // also: any element anywhere in a sibling branch of the parent
          if (siblingChosen) continue;
        }
        issues.push({ path: here, uid: node.uid, kind: "child", msg: `requires one of: ${opts.map((o) => o.name).join(", ")}` });
        continue;
      }
      if (ch.minOccurs < 1) continue;
      if ((counts[ch.name] || 0) < ch.minOccurs) {
        issues.push({ path: here, uid: node.uid, kind: "child", msg: `missing required child <${ch.name}>` });
      }
    }
    for (const c of node.children) walk(c, here);
  }
  walk(root, "");
  return issues;
}

const SAMPLE_HINT = "Upload your descript.xsd (or any S1000D .xsd) to begin.";

export default function App() {
  const [store, setStore] = useState(null);
  const [tree, setTree] = useState(null);
  const [selectedUid, setSelectedUid] = useState(null);
  const [modalNode, setModalNode] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [issues, setIssues] = useState(null);
  const [splitPct, setSplitPct] = useState(50); // left pane width %
  const [xslName, setXslName] = useState(null); // referenced stylesheet filename
  const xslFileRef = useRef(null);
  const draggingRef = useRef(false);
  const fileRef = useRef(null);
  const xmlFileRef = useRef(null);
  const [, forceRender] = useState(0);
  const rerender = () => forceRender((x) => x + 1);

  // find node by uid
  const findNode = useCallback((root, uid) => {
    if (!root) return null;
    if (root.uid === uid) return root;
    for (const c of root.children) {
      const r = findNode(c, uid);
      if (r) return r;
    }
    return null;
  }, []);

  const findParent = useCallback((root, uid, parent = null) => {
    if (!root) return null;
    if (root.uid === uid) return parent;
    for (const c of root.children) {
      const r = findParent(c, uid, root);
      if (r !== null) return r;
    }
    return null;
  }, []);

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const s = parseXSD(ev.target.result);
        setStore(s);
        const skel = buildSkeleton(s, s.rootElement, 0, []);
        setTree(skel);
        setSelectedUid(skel.uid);
        setError(null);
      } catch (err) {
        setError(err.message);
        setStore(null);
        setTree(null);
      }
    };
    reader.readAsText(file);
  }

  function handleXMLFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!store) {
      setError("Load the matching XSD schema first, then load the XML.");
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = importXML(store, ev.target.result);
        setTree(imported);
        setSelectedUid(imported.uid);
        setIssues(null);
        setError(null);
      } catch (err) {
        setError(err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  // Resizable split between editor and preview
  useEffect(() => {
    function onMove(e) {
      if (!draggingRef.current) return;
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      const pct = (x / window.innerWidth) * 100;
      setSplitPct(Math.min(80, Math.max(20, pct))); // clamp 20–80%
    }
    function onUp() {
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove);
    window.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
  }, []);

  function startDrag() {
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  // Warn before leaving if there's an in-progress document (unsaved work)
  useEffect(() => {
    function beforeUnload(e) {
      if (tree) {
        e.preventDefault();
        e.returnValue = ""; // required for the browser to show its prompt
        return "";
      }
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [tree]);

  // Keyboard shortcut: Ctrl+D opens attribute modal for selected node
  useEffect(() => {
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        if (selectedUid && tree) {
          const n = findNode(tree, selectedUid);
          if (n) setModalNode(n);
        }
      }
      if (e.key === "Escape") setModalNode(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedUid, tree, findNode]);

  function addChild(parentNode, childName) {
    const newNode = buildSkeleton(store, childName, 0, [parentNode.name]);
    parentNode.children.push(newNode);
    parentNode.expanded = true;
    setSelectedUid(newNode.uid);
    rerender();
  }

  function removeNode(uid) {
    const parent = findParent(tree, uid);
    if (!parent) return; // can't remove root
    parent.children = parent.children.filter((c) => c.uid !== uid);
    if (selectedUid === uid) setSelectedUid(parent.uid);
    rerender();
  }

  function applyAttributes(node, values) {
    node.attributes = { ...values };
    setModalNode(null);
    rerender();
  }

  function applyText(node, text) {
    node.text = text;
    rerender();
  }

  function runValidation() {
    if (!tree || !store) return;
    setIssues(validateDocument(store, tree));
  }

  function handleXSLFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setXslName(file.name); // reference by filename in the output PI
    e.target.value = "";
  }

  const xmlOutput = tree && store ? serializeDoc(tree, store, xslName) : "";

  function copyXML() {
    navigator.clipboard?.writeText(xmlOutput);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function downloadXML() {
    const filename = (store?.rootElement || "document") + ".xml";
    const content = serializeDoc(tree, store, xslName); // include XSL reference, same as preview
    try {
      const blob = new Blob([content], { type: "application/xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    } catch (e) {
      try {
        const w = window.open();
        if (w) {
          w.document.write("<pre style='white-space:pre-wrap;word-break:break-word'>" +
            content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
            "</pre>");
          w.document.title = filename;
        } else {
          throw new Error("popup blocked");
        }
      } catch (e2) {
        navigator.clipboard?.writeText(content);
        setError("Download was blocked by the sandbox. The XML has been copied to your clipboard — paste it into a new file and save as " + filename + ".");
      }
    }
  }

  return (
    <div className="w-full h-screen flex flex-col bg-slate-50 text-slate-800" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-slate-900 text-white shadow">
        <FileCode className="w-5 h-5 text-cyan-400" />
        <h1 className="font-semibold text-sm tracking-wide">S1000D XML Builder</h1>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 text-xs bg-cyan-600 hover:bg-cyan-500 px-3 py-1.5 rounded transition">
            <Upload className="w-3.5 h-3.5" /> Load XSD
          </button>
          <input ref={fileRef} type="file" accept=".xsd,.xml" onChange={handleFile} className="hidden" />
          <button onClick={() => xmlFileRef.current?.click()} disabled={!store} title={!store ? "Load an XSD first" : "Load an existing XML document"} className="flex items-center gap-1.5 text-xs bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1.5 rounded transition">
            <FileCode className="w-3.5 h-3.5" /> Load XML
          </button>
          <input ref={xmlFileRef} type="file" accept=".xml" onChange={handleXMLFile} className="hidden" />
          {tree && (
            <>
              <button onClick={() => xslFileRef.current?.click()} title="Reference an .xsl stylesheet in the exported XML" className="flex items-center gap-1.5 text-xs bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded transition">
                <FileCode className="w-3.5 h-3.5" /> {xslName ? "XSL ✓" : "Link XSL"}
              </button>
              <input ref={xslFileRef} type="file" accept=".xsl,.xslt" onChange={handleXSLFile} className="hidden" />
              <button onClick={runValidation} className="flex items-center gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 rounded transition">
                <ShieldCheck className="w-3.5 h-3.5" /> Validate
              </button>
              <button onClick={copyXML} className="flex items-center gap-1.5 text-xs bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded transition">
                {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />} {copied ? "Copied" : "Copy"}
              </button>
              <button onClick={downloadXML} className="flex items-center gap-1.5 text-xs bg-green-600 hover:bg-green-500 px-3 py-1.5 rounded transition">
                <Download className="w-3.5 h-3.5" /> Download
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-100 text-red-700 text-xs px-4 py-2 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {issues !== null && (
        <div className="bg-white border-b border-slate-200 max-h-48 overflow-auto">
          <div className="flex items-center gap-2 px-4 py-2 sticky top-0 bg-white border-b border-slate-100">
            {issues.length === 0 ? (
              <><Check className="w-4 h-4 text-green-600" /><span className="text-xs font-medium text-green-700">Document is valid — no issues found.</span></>
            ) : (
              <><AlertCircle className="w-4 h-4 text-amber-600" /><span className="text-xs font-medium text-amber-700">{issues.length} issue{issues.length > 1 ? "s" : ""} found</span></>
            )}
            <button onClick={() => setIssues(null)} className="ml-auto text-slate-400 hover:text-slate-700"><X className="w-3.5 h-3.5" /></button>
          </div>
          {issues.map((iss, i) => (
            <button
              key={i}
              onClick={() => setSelectedUid(iss.uid)}
              className="w-full text-left flex items-start gap-2 px-4 py-1.5 text-xs hover:bg-slate-50 border-b border-slate-50"
            >
              <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${iss.kind === "attribute" ? "bg-red-400" : "bg-amber-400"}`} />
              <span className="font-mono text-slate-400">{iss.path}</span>
              <span className="text-slate-700">{iss.msg}</span>
            </button>
          ))}
        </div>
      )}

      {!tree ? (
        <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3">
          <FileCode className="w-12 h-12 text-slate-300" />
          <p className="text-sm">{SAMPLE_HINT}</p>
          <p className="text-xs text-slate-400 max-w-md text-center">
            Select an element in the tree, then press <kbd className="px-1.5 py-0.5 bg-slate-200 rounded text-slate-600 font-mono">Ctrl+D</kbd> to open its attribute editor.
          </p>
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* Tree / editor */}
          <div className="overflow-auto border-r border-slate-200 bg-white" style={{ width: `${splitPct}%` }}>
            <div className="p-3">
              <TreeNode
                node={tree}
                store={store}
                depth={0}
                selectedUid={selectedUid}
                onSelect={setSelectedUid}
                onAddChild={addChild}
                onRemove={removeNode}
                onOpenAttrs={setModalNode}
                onText={applyText}
                rerender={rerender}
              />
            </div>
          </div>
          {/* Drag handle */}
          <div
            onMouseDown={startDrag}
            onTouchStart={startDrag}
            className="w-1.5 bg-slate-200 hover:bg-cyan-400 active:bg-cyan-500 cursor-col-resize flex-shrink-0 transition-colors"
            title="Drag to resize"
          />
          {/* XML preview */}
          <div className="flex flex-col bg-slate-900" style={{ width: `${100 - splitPct}%` }}>
            <div className="px-3 py-2 text-xs text-slate-400 border-b border-slate-700 flex items-center gap-2">
              <FileCode className="w-3.5 h-3.5" /> Live XML Output
              {xslName && (
                <span className="ml-auto flex items-center gap-1.5 text-cyan-400">
                  <span title="Stylesheet referenced in output">↳ {xslName}</span>
                  <button onClick={() => setXslName(null)} title="Remove stylesheet reference" className="text-slate-500 hover:text-red-400">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}
            </div>
            <pre className="flex-1 overflow-auto p-3 text-xs leading-relaxed text-slate-100 font-mono whitespace-pre">{xmlOutput}</pre>
          </div>
        </div>
      )}

      {/* Attribute Modal */}
      {modalNode && (
        <AttributeModal
          node={modalNode}
          store={store}
          onClose={() => setModalNode(null)}
          onApply={applyAttributes}
        />
      )}
    </div>
  );
}

function TreeNode({ node, store, depth, selectedUid, onSelect, onAddChild, onRemove, onOpenAttrs, onText, rerender }) {
  const typeName = node.typeName;
  const allowedChildren = collectChildren(store, store.complexTypes[typeName]).filter((c) => !c.external);
  const isSelected = node.uid === selectedUid;
  const attrCount = Object.values(node.attributes).filter((v) => v !== "" && v != null).length;
  const reqAttrs = node._attrDefs.filter((a) => a.use === "required");
  const missingReq = reqAttrs.some((a) => !node.attributes[a.name]);

  // which children can still be added (respect maxOccurs)
  const childCounts = {};
  for (const c of node.children) childCounts[c.name] = (childCounts[c.name] || 0) + 1;
  const addable = allowedChildren.filter((c) => (childCounts[c.name] || 0) < c.maxOccurs);

  const [showAdd, setShowAdd] = useState(false);

  return (
    <div className="select-none">
      <div
        className={`group flex items-center gap-1 rounded px-1.5 py-1 cursor-pointer text-sm ${isSelected ? "bg-cyan-50 ring-1 ring-cyan-300" : "hover:bg-slate-50"}`}
        style={{ marginLeft: depth * 14 }}
        onClick={() => onSelect(node.uid)}
      >
        {node.children.length > 0 ? (
          <button onClick={(e) => { e.stopPropagation(); node.expanded = !node.expanded; rerender(); }} className="text-slate-400 hover:text-slate-700">
            {node.expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <span className="w-3.5 inline-block" />
        )}
        <span className="font-mono text-cyan-700 font-medium">&lt;{node.name}&gt;</span>
        {attrCount > 0 && <span className="text-[10px] text-slate-400">· {attrCount} attr</span>}
        {missingReq && <span title="Missing required attribute" className="text-amber-500"><AlertCircle className="w-3 h-3" /></span>}

        <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
          {node._attrDefs.length > 0 && (
            <button title="Edit attributes (Ctrl+D)" onClick={(e) => { e.stopPropagation(); onSelect(node.uid); onOpenAttrs(node); }} className="p-1 text-slate-400 hover:text-cyan-600">
              <Settings className="w-3.5 h-3.5" />
            </button>
          )}
          {addable.length > 0 && (
            <button title="Add child element" onClick={(e) => { e.stopPropagation(); setShowAdd((s) => !s); }} className="p-1 text-slate-400 hover:text-green-600">
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
          {depth > 0 && (
            <button title="Remove element" onClick={(e) => { e.stopPropagation(); onRemove(node.uid); }} className="p-1 text-slate-400 hover:text-red-600">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* add-child dropdown */}
      {showAdd && addable.length > 0 && (
        <div className="ml-8 my-1 p-2 bg-slate-50 border border-slate-200 rounded text-xs" style={{ marginLeft: depth * 14 + 24 }}>
          <div className="text-slate-400 mb-1">Add child:</div>
          <div className="flex flex-wrap gap-1">
            {addable.map((c) => (
              <button
                key={c.name}
                onClick={() => { onAddChild(node, c.name); setShowAdd(false); }}
                className="px-2 py-0.5 bg-white border border-slate-200 rounded hover:bg-cyan-50 hover:border-cyan-300 font-mono text-cyan-700"
              >
                {c.name}{c.minOccurs < 1 ? "?" : ""}{c.maxOccurs === Infinity ? "*" : ""}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* text content editor */}
      {isSelected && node.hasText && (
        <div className="my-1 flex items-center gap-1.5" style={{ marginLeft: depth * 14 + 24 }}>
          <input
            value={node.text}
            onChange={(e) => onText(node, e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } }}
            placeholder="text content — type, then Enter…"
            className="flex-1 max-w-md text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-cyan-300 font-mono"
          />
          {node.text && node.text.trim() !== "" && (
            <span className="flex items-center gap-0.5 text-[10px] text-green-600" title="Saved to XML">
              <Check className="w-3 h-3" /> saved
            </span>
          )}
        </div>
      )}

      {node.expanded && node.children.map((c) => (
        <TreeNode
          key={c.uid}
          node={c}
          store={store}
          depth={depth + 1}
          selectedUid={selectedUid}
          onSelect={onSelect}
          onAddChild={onAddChild}
          onRemove={onRemove}
          onOpenAttrs={onOpenAttrs}
          onText={onText}
          rerender={rerender}
        />
      ))}
    </div>
  );
}

function AttributeModal({ node, store, onClose, onApply }) {
  const defs = node._attrDefs;
  const [values, setValues] = useState(() => ({ ...node.attributes }));
  const [errors, setErrors] = useState({});

  function setVal(name, v) {
    setValues((prev) => ({ ...prev, [name]: v }));
  }

  function validateAll() {
    const errs = {};
    for (const d of defs) {
      const e = validateAttr(d, values[d.name] || "");
      if (e) errs[d.name] = e;
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function submit() {
    if (validateAll()) {
      // strip empties
      const clean = {};
      for (const [k, v] of Object.entries(values)) if (v !== "" && v != null) clean[k] = v;
      onApply(node, clean);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
          <Settings className="w-4 h-4 text-cyan-600" />
          <h2 className="font-semibold text-sm">Attributes — <span className="font-mono text-cyan-700">&lt;{node.name}&gt;</span></h2>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-3">
          {defs.length === 0 && <p className="text-xs text-slate-400">This element has no attributes.</p>}
          {defs.map((d) => {
            const val = values[d.name] || "";
            const err = errors[d.name];
            return (
              <div key={d.name}>
                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600 mb-1">
                  <span className="font-mono">{d.name}</span>
                  {d.use === "required" && <span className="text-red-500">*</span>}
                  {d.external && <span className="text-[10px] bg-amber-100 text-amber-700 px-1 rounded">external</span>}
                  {d.enums && d.enums.length > 0 && <span className="text-[10px] text-slate-400">({d.enums.length} options)</span>}
                </label>
                {d.enums && d.enums.length > 0 ? (
                  <select
                    value={val}
                    onChange={(e) => setVal(d.name, e.target.value)}
                    className={`w-full text-xs border rounded px-2 py-1.5 font-mono focus:outline-none focus:ring-1 ${err ? "border-red-400 ring-red-300" : "border-slate-200 focus:ring-cyan-300"}`}
                  >
                    <option value="">— none —</option>
                    {d.enums.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                ) : (
                  <input
                    value={val}
                    onChange={(e) => setVal(d.name, e.target.value)}
                    placeholder={d.pattern ? d.pattern : (d.base || "value")}
                    className={`w-full text-xs border rounded px-2 py-1.5 font-mono focus:outline-none focus:ring-1 ${err ? "border-red-400 ring-red-300" : "border-slate-200 focus:ring-cyan-300"}`}
                  />
                )}
                {d.pattern && !d.enums?.length && <div className="text-[10px] text-slate-400 mt-0.5 font-mono">pattern: {d.pattern}</div>}
                {err && <div className="text-[10px] text-red-500 mt-0.5">{err}</div>}
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-200">
          <span className="text-[10px] text-slate-400">Strict validation on · <kbd className="px-1 bg-slate-100 rounded">Esc</kbd> to cancel</span>
          <div className="ml-auto flex gap-2">
            <button onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-slate-200 hover:bg-slate-50">Cancel</button>
            <button onClick={submit} className="text-xs px-3 py-1.5 rounded bg-cyan-600 text-white hover:bg-cyan-500">Submit</button>
          </div>
        </div>
      </div>
    </div>
  );
}