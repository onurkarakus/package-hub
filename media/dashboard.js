// PackageHub Health Dashboard page. The extension sends the state with
// postMessage; this file only draws it and sends back user actions.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const ui = {
    q: typeof saved.q === "string" ? saved.q : "",
    kind: saved.kind === "direct" || saved.kind === "transitive" ? saved.kind : "all",
    filter: typeof saved.filter === "string" ? saved.filter : null,
    sort: typeof saved.sort === "string" ? saved.sort : "severity",
    dir: saved.dir === 1 ? 1 : -1,
    open: typeof saved.open === "string" ? saved.open : null,
    tab: saved.tab === "feeds" ? "feeds" : "actions",
  };
  /** @type {any} */
  let state = null;

  const SEV_RANK = { critical: 4, high: 3, moderate: 2, low: 1, unknown: 0, none: 0 };
  const CHANGE_RANK = { major: 5, replace: 4, minor: 3, patch: 2, none: 1 };
  const SORT_NAMES = { severity: "Severity", name: "Package", current: "Current", change: "Change", projects: "Projects", kind: "Type" };
  const BANDS = { healthy: "Healthy", fair: "Fair", attention: "Needs attention", risk: "At risk" };

  function $(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function icon(name, extra) { return '<svg class="i ' + (extra || "") + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>'; }
  function cap(text) { return text ? text.charAt(0).toUpperCase() + text.slice(1) : ""; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
  function save() { vscode.setState(ui); }
  function post(message) { vscode.postMessage(message); }

  // Header ------------------------------------------------------------------
  function renderHeader() {
    const s = state.score;
    const ring = $("ring");
    const value = $("ring-value");
    const circ = 2 * Math.PI * 36;
    value.setAttribute("stroke-dasharray", circ.toFixed(2));
    value.setAttribute("stroke-dashoffset", (circ * (1 - s.score / 100)).toFixed(2));
    ring.className = "ring live " + s.band;
    ring.setAttribute("aria-label", "Health score " + s.score + " of 100");
    $("score").textContent = String(s.score);
    const verdict = $("verdict");
    verdict.textContent = BANDS[s.band] || "";
    verdict.className = "verdict live tint " + s.band;

    const sub = ['<span>' + icon("proj", "sm") + plural(state.projects.length, "project") + "</span>"];
    if (state.cpm) {
      const files = state.centralFiles.length > 0 ? ' · <span class="file">' + esc(state.centralFiles[0]) + "</span>" : "";
      sub.push("<span>" + icon("archive", "sm") + "Central package management" + files + "</span>");
    }
    if (state.conflicts > 0) {
      sub.push("<span>" + icon("warn", "sm") + plural(state.conflicts, "version conflict") + "</span>");
    }
    if (state.ignored > 0) {
      sub.push("<span>" + plural(state.ignored, "ignored package") + "</span>");
    }
    $("sub").innerHTML = sub.join("");

    const chips = [
      '<span class="chip">Vulnerabilities <b>−' + s.vulnerable + "</b></span>",
      '<span class="chip">Outdated <b>−' + s.outdated + "</b></span>",
      '<span class="chip">Deprecated <b>−' + s.deprecated + "</b></span>",
      '<span class="chip">Feeds <b>−' + s.feeds + "</b></span>",
    ];
    const first = state.actions[0];
    if (first && first.score) {
      chips.push('<span class="chip next">' + icon("arrow", "sm") + "After action 1 <b>" + first.score.to + "</b></span>");
    }
    $("breakdown").innerHTML = chips.join("");

    const sc = s.severityCounts;
    const vParts = ["critical", "high", "moderate", "low"]
      .filter((k) => sc[k] > 0)
      .map((k) => sc[k] + "×" + { critical: 15, high: 8, moderate: 4, low: 1 }[k]);
    const total = s.vulnerable + s.outdated + s.deprecated + s.feeds;
    $("formula-tip").innerHTML =
      "<h4>How the health score is calculated</h4>" +
      "<code>score = max(0, 100 − V − O − D − F)</code>" +
      "<table>" +
      '<tr><td>V · vulnerable packages, worst advisory each<br><span class="muted">critical 15 · high 8 · moderate 4 · low 1 · max 60</span></td><td>' +
      (vParts.length ? vParts.join(" + ") + " = " + s.vulnerableRaw + (s.vulnerableRaw !== s.vulnerable ? " → " + s.vulnerable : "") : "0") + "</td></tr>" +
      '<tr><td>O · outdated direct packages <span class="muted">· 2 each · max 20</span></td><td>' + s.counts.outdated + "×2 = " + s.outdated + "</td></tr>" +
      '<tr><td>D · deprecated direct packages <span class="muted">· 4 each · max 12</span></td><td>' + s.counts.deprecated + "×4 = " + s.deprecated + "</td></tr>" +
      '<tr><td>F · feeds with an issue <span class="muted">· 4 each · max 8</span></td><td>' + s.counts.feeds + "×4 = " + s.feeds + "</td></tr>" +
      '<tr class="total"><td>Score</td><td>100 − ' + total + " = " + s.score + "</td></tr>" +
      "</table>" +
      "<p>80+ healthy · 60–79 fair · 40–59 needs attention · under 40 at risk. Caps stop one kind of problem from hiding the others.</p>";

    const when = state.scannedAt ? new Date(state.scannedAt).toLocaleString() : "";
    const mode = state.online ? "online lookups on" : "local only";
    $("scan-meta").innerHTML = state.hasScan
      ? icon("check", "sm") + "Scanned " + esc(when) + " · dotnet CLI · " + mode
      : "Not scanned yet";

    $("notices").innerHTML = state.notices.map((text) => '<div class="notice">' + icon("warn", "sm") + "<span>" + esc(text) + "</span></div>").join("");
  }

  // Summary cards -----------------------------------------------------------
  function renderKpis() {
    const pk = state.packages;
    const vuln = pk.filter((p) => p.vulnerable);
    const vDirect = vuln.filter((p) => p.kind === "direct").length;
    const outd = pk.filter((p) => p.outdated && p.kind === "direct");
    const by = (c) => outd.filter((p) => p.change === c).length;
    const dep = pk.filter((p) => p.deprecated && p.kind === "direct");
    const reasons = {};
    dep.forEach((p) => { reasons[p.deprecated] = (reasons[p.deprecated] || 0) + 1; });
    const sc = state.score.severityCounts;
    const sevTotal = sc.critical + sc.high + sc.moderate + sc.low;
    const bar = ["critical", "high", "moderate", "low"]
      .filter((k) => sc[k] > 0)
      .map((k) => '<i class="' + k + '" data-w="' + (100 * sc[k] / sevTotal) + '"></i>').join("");
    const sevText = ["critical", "high", "moderate", "low"].filter((k) => sc[k] > 0).map((k) => sc[k] + " " + k).join(" · ") || "none";
    const feeds = state.feeds;
    const firstFeed = feeds.items.find((f) => f.enabled) || feeds.items[0];
    const feedLine = firstFeed
      ? '<span><span class="dot' + (firstFeed.failures.length ? " bad" : "") + '"></span>' + esc(firstFeed.name) + (firstFeed.enabled ? (firstFeed.failures.length ? " failed" : " enabled") : " disabled") + "</span>"
      : "<span>" + (feeds.listed ? "No sources" : "Sources not listed") + "</span>";

    const cards = [
      { k: "vulnerable", ic: "shield", label: "Vulnerable", value: vuln.length, small: "packages · " + plural(state.advisoryCount, "advisory", "advisories"),
        side: "<span>" + esc(sevText) + '</span><span class="bar">' + bar + "</span><span>" + vDirect + " direct · " + (vuln.length - vDirect) + " transitive</span>" },
      { k: "outdated", ic: "up", label: "Outdated", value: outd.length, small: "direct packages",
        side: "<span>Suggested bump</span><span>" + by("patch") + " patch · " + by("minor") + " minor · " + by("major") + " major</span>" },
      { k: "deprecated", ic: "archive", label: "Deprecated", value: dep.length, small: "direct packages",
        side: Object.keys(reasons).map((r) => "<span>" + reasons[r] + " " + esc(r) + "</span>").join("") || "<span>none</span>" },
      { k: "feeds", ic: "feed", label: "Feeds", value: feeds.items.length, small: (feeds.items.length === 1 ? "source" : "sources") + " · " + plural(feeds.issues, "issue"),
        side: feedLine + (firstFeed ? '<span class="mono">' + esc(shortUrl(firstFeed.url)) + "</span>" : "") },
    ];
    $("kpis").innerHTML = cards.map((c) => {
      const on = c.k === "feeds" ? ui.tab === "feeds" : ui.filter === c.k;
      const extra = c.k === "feeds" && feeds.issues > 0 ? " has-issues" : "";
      return '<button type="button" class="card kpi' + extra + (on ? " is-active" : "") + '" data-kpi="' + c.k + '" aria-pressed="' + on + '">' +
        '<span class="kpi-icon tint">' + icon(c.ic) + '</span><span class="kpi-label">' + esc(c.label) + "</span>" +
        '<span class="kpi-value">' + c.value + "<small>" + esc(c.small) + '</small></span><span class="kpi-side">' + c.side + "</span></button>";
    }).join("");
    document.querySelectorAll(".kpi-side .bar i").forEach((el) => { el.style.width = el.getAttribute("data-w") + "%"; });
  }

  function shortUrl(url) {
    return String(url || "").replace(/^https?:\/\//, "").replace(/\/index\.json$/, "");
  }

  // Package table -----------------------------------------------------------
  function projectCount(p) { return p.directIn.length + p.transitiveIn.length; }
  function statusRank(p) {
    const sev = SEV_RANK[p.severity] || 0;
    if (p.vulnerable) {
      return 1000 + sev * 100 + projectCount(p) * 2 + p.advisories.length;
    }
    return (p.deprecated && p.kind === "direct" ? 20 : 0) + (p.outdated ? 10 : 0);
  }
  function matches(p) {
    if (ui.kind !== "all" && p.kind !== ui.kind) { return false; }
    const f = ui.filter;
    if (f === "vulnerable" && !p.vulnerable) { return false; }
    if (f === "outdated" && !p.outdated) { return false; }
    if (f === "deprecated" && !p.deprecated) { return false; }
    if (f && f.indexOf("project:") === 0) {
      const name = f.slice(8).toLowerCase();
      if (!p.directIn.concat(p.transitiveIn).some((n) => n.toLowerCase() === name)) { return false; }
    }
    if (!ui.q) { return true; }
    const hay = [p.id, p.current, p.suggested || "", p.alternative || ""]
      .concat(p.directIn, p.transitiveIn, p.parents, p.advisories.map((a) => a.id)).join(" ").toLowerCase();
    return hay.indexOf(ui.q.toLowerCase()) >= 0;
  }
  function compare(a, b) {
    let r = 0;
    switch (ui.sort) {
      case "name": r = a.id.localeCompare(b.id); break;
      case "current": r = a.current.localeCompare(b.current, undefined, { numeric: true }); break;
      case "change": r = (CHANGE_RANK[a.change] || 0) - (CHANGE_RANK[b.change] || 0); break;
      case "projects": r = projectCount(a) - projectCount(b); break;
      case "kind": r = a.kind.localeCompare(b.kind); break;
      default: r = statusRank(a) - statusRank(b);
    }
    return r ? r * ui.dir : a.id.localeCompare(b.id);
  }
  function changeBadge(p) {
    const label = { patch: "Patch", minor: "Minor", major: "Major", replace: "Replace", none: "—" }[p.change] || "—";
    return '<span class="badge tint ' + esc(p.change) + '">' + label + "</span>";
  }
  function sevPill(p) {
    if (p.severity === "none" || !p.vulnerable) { return '<span class="sev none">—</span>'; }
    const n = p.advisories.length;
    return '<span class="sev tint ' + esc(p.severity) + '"><span class="pip"></span>' + cap(p.severity) + (n > 1 ? ' <span class="n">×' + n + "</span>" : "") + "</span>";
  }
  function projectBars(p) {
    const total = state.projects.length;
    const on = projectCount(p);
    let html = '<span class="prj' + (total > 6 ? " many" : "") + '" title="' + esc(p.directIn.concat(p.transitiveIn).join(", ")) + '">';
    if (total <= 6) {
      for (let i = 0; i < total; i++) { html += '<i class="' + (i < on ? "on" : "") + '"></i>'; }
    }
    return html + "<span>" + on + "/" + total + "</span></span>";
  }
  function suggestedCell(p) {
    const arrow = '<span class="arrow">' + icon("arrow", "sm") + "</span>";
    if (p.change === "replace" && p.alternative) {
      return '<span class="sug">' + arrow + '<span class="alt">' + esc(p.alternative) + "</span></span>";
    }
    if (!p.suggested) {
      return '<span class="sug muted">—</span>';
    }
    const via = p.kind === "transitive"
      ? '<span class="via">pin' + (p.parents.length ? " · via " + esc(p.parents[0]) : "") + "</span>"
      : "";
    return '<span class="sug">' + arrow + '<span class="ver">' + esc(p.suggested) + "</span>" + via + "</span>";
  }
  function verdictLine(p, a) {
    if (!p.suggested) { return '<span class="verdict-line unknown">' + icon("info", "sm") + "No fixed version in the local data</span>"; }
    if (a.verdict === "closed") { return '<span class="verdict-line">' + icon("check", "sm") + "Closed by " + esc(p.suggested) + "</span>"; }
    if (a.verdict === "open") { return '<span class="verdict-line open">' + icon("warn", "sm") + "Still open in " + esc(p.suggested) + "</span>"; }
    return '<span class="verdict-line unknown">' + icon("info", "sm") + "No local range for this advisory</span>";
  }
  function detailHtml(p) {
    const adv = p.advisories.length
      ? p.advisories.map((a) =>
        '<div class="adv"><span><span class="sev tint ' + esc(a.severity) + '"><span class="pip"></span>' + cap(a.severity) + '</span></span><span class="id">' + esc(a.id) + "</span>" +
        '<span class="range">Installed ' + esc(p.current) + "</span>" +
        '<a href="#" data-action="openAdvisory" data-url="' + esc(a.url) + '">' + esc(shortUrl(a.url)) + icon("ext", "sm") + "</a>" +
        verdictLine(p, a) + "</div>").join("")
      : '<div class="muted">' + (p.vulnerable ? "dotnet lists this package as vulnerable without an advisory link." : "No known advisories.") + "</div>";
    const projects = p.directIn.map((n) => [n, "direct"]).concat(p.transitiveIn.map((n) => [n, "transitive"]));
    const plist = '<ul class="plist">' + projects.map((x) =>
      "<li><span class=\"ico\">" + icon("proj", "sm") + "</span>" + esc(x[0]) + '<span class="kind ' + x[1] + '">' + x[1] + "</span></li>").join("") + "</ul>";
    const why = p.why.map((path) => '<div class="why-path"><div class="why">' + path.map((node, i) => {
      const target = i === path.length - 1;
      return '<div class="node' + (node.kind === "project" ? " project" : "") + (target ? " target" : "") + '"><span class="dot-n"></span><span>' + esc(node.name) + "</span>" +
        (node.kind === "project" ? '<span class="tag">project</span>' : node.version ? '<span class="ver">' + esc(node.version) + "</span>" : "") + "</div>";
    }).join("") + "</div></div>").join("");
    const note = p.note
      ? '<div class="note tint' + (p.note.tone === "warn" ? " warn" : "") + '">' + icon(p.note.tone === "warn" ? "warn" : "check", "sm") + "<span>" + esc(p.note.text) + "</span></div>"
      : "";
    let primary = "";
    if (p.suggested && p.change !== "replace") {
      const label = p.kind === "transitive" ? "Pin " + esc(p.suggested) : "Update to " + esc(p.suggested);
      primary = '<button class="btn" type="button" data-action="updatePackage" data-id="' + esc(p.id) + '" data-version="' + esc(p.suggested) + '">' + label + "</button>";
    }
    return '<tr class="detail"><td colspan="8"><div class="detail-grid">' +
      "<section><h3>" + icon("shield", "sm") + "Advisories (" + p.advisories.length + ")</h3>" + adv + "</section>" +
      "<section><h3>" + icon("proj", "sm") + "Affected projects (" + projects.length + ")</h3>" + plist + "</section>" +
      "<section><h3>" + icon("graph", "sm") + "Why is it here</h3>" + (why || '<div class="muted">No path recorded.</div>') + note +
      '<div class="detail-actions">' + primary + '<button class="btn secondary" type="button" data-action="showDependencies" data-id="' + esc(p.id) + '">Open dependency graph</button></div></section>' +
      "</div></td></tr>";
  }
  function renderTable() {
    const rows = state.packages.filter(matches).sort(compare);
    $("row-count").textContent = String(rows.length);
    let body = rows.map((p) => {
      const open = ui.open === p.id;
      const flags = (p.deprecated ? '<span class="flag dep">deprecated</span>' : "") + (p.outdated && !p.vulnerable ? '<span class="flag out">outdated</span>' : "");
      const extra = p.kind === "direct" && p.transitiveIn.length ? '<span class="kind-extra">+' + p.transitiveIn.length + " trans.</span>" : "";
      return '<tr class="row' + (open ? " is-open" : "") + '" tabindex="0" data-id="' + esc(p.id) + '" aria-expanded="' + open + '">' +
        '<td><span class="chev">' + icon("chev", "sm") + "</span></td>" +
        '<td><span class="pkg"><span class="pkg-name">' + esc(p.id) + "</span>" + flags + "</span></td>" +
        '<td><span class="ver">' + esc(p.current) + "</span></td><td>" + suggestedCell(p) + "</td><td>" + changeBadge(p) + "</td>" +
        "<td>" + sevPill(p) + "</td><td>" + projectBars(p) + '</td><td><span class="kind ' + p.kind + '">' + p.kind + "</span>" + extra + "</td></tr>" +
        (open ? detailHtml(p) : "");
    }).join("");
    if (!body) {
      body = !state.hasScan
        ? '<tr><td colspan="8" class="empty"><strong>No scan yet</strong>Run a scan to see the packages that need attention.<div class="detail-actions"><button class="btn" type="button" data-action="refresh">Scan workspace</button></div></td></tr>'
        : state.packages.length === 0
          ? '<tr><td colspan="8" class="empty"><strong>Nothing needs attention</strong>No vulnerable, outdated or deprecated packages in the last scan.</td></tr>'
          : '<tr><td colspan="8" class="empty">No packages match the current filters.</td></tr>';
    }
    $("rows").innerHTML = body;
    document.querySelectorAll("th[data-sort]").forEach((th) => {
      const on = th.getAttribute("data-sort") === ui.sort;
      th.classList.toggle("is-sorted", on);
      th.classList.toggle("asc", on && ui.dir > 0);
      th.setAttribute("aria-sort", on ? (ui.dir < 0 ? "descending" : "ascending") : "none");
    });
    $("sort-label").innerHTML = "Sorted by <b>" + SORT_NAMES[ui.sort] + "</b>";
    const f = ui.filter;
    $("filter-pill").classList.toggle("is-on", !!f);
    $("filter-pill-text").textContent = f ? (f.indexOf("project:") === 0 ? f.slice(8) : cap(f)) : "";
    document.querySelectorAll("#kind-seg button").forEach((b) => b.classList.toggle("is-on", b.getAttribute("data-kind") === ui.kind));
    document.querySelectorAll(".proj[data-project]").forEach((el) => el.classList.toggle("is-active", f === "project:" + el.getAttribute("data-project")));
  }

  // Actions and feeds -------------------------------------------------------
  function renderActions() {
    $("act-count").textContent = String(state.actions.length);
    const html = state.actions.map((a, i) => {
      const shown = a.updates.length > 6 ? a.updates.slice(0, 5) : a.updates;
      const more = a.updates.length - shown.length;
      const diffs = shown.map((u) => u.change === "replace"
        ? '<div class="diff"><span class="name">' + esc(u.packageId) + " " + esc(u.from) + '</span></div><div class="diff"><span class="name">→ <span class="to replace">' + esc(u.to) + "</span></span></div>"
        : '<div class="diff"><span class="name">' + esc(u.packageId) + '</span><span class="ver">' + esc(u.from) + ' → <span class="to ' + esc(u.change) + '">' + esc(u.to) + "</span></span></div>").join("") +
        (more ? '<div class="diff"><span class="name muted">and ' + more + " more</span></div>" : "");
      const files = a.files.map((f) => '<span class="file" title="' + esc(f) + '">' + esc(f) + "</span>").join(" ");
      const closes = a.kind === "minor" || a.kind === "replace" && a.closes === 0
        ? ""
        : "<dt>Closes</dt><dd>" + plural(a.closes, "advisory", "advisories") + "</dd>";
      const facts = closes +
        (i === 0 || a.projects.length > 1 ? "<dt>Projects</dt><dd>" + esc(a.projects.join(", ") || "—") + "</dd>" : "") +
        (files ? "<dt>Edits</dt><dd>" + files + "</dd>" : "") +
        (a.score ? '<dt>Score</dt><dd><span class="bad">' + a.score.from + '</span> → <span class="ok">' + a.score.to + '</span> <span class="muted">estimated</span></dd>' : "");
      const side = a.warning
        ? '<span class="side-note warn">' + icon("warn", "sm") + esc(a.warning) + "</span>"
        : a.projects.length === 1 && i !== 0 ? '<span class="side-note">' + icon("proj", "sm") + esc(a.projects[0]) + "</span>" : "";
      return '<article class="act' + (i === 0 ? " primary" : "") + '">' +
        '<div class="act-head"><span class="act-num">' + (i + 1) + '</span><div><div class="act-title">' + esc(a.title) + '</div><div class="act-desc">' + esc(a.description) + "</div></div>" +
        '<span class="badge tint ' + esc(a.badge) + '">' + cap(a.badge) + "</span></div>" +
        (diffs ? '<div class="diffs">' + diffs + "</div>" : "") +
        (facts ? '<dl class="facts">' + facts + "</dl>" : "") +
        '<div class="act-foot"><button class="btn' + (i === 0 ? "" : " secondary") + '" type="button" data-action="applyAction" data-id="' + esc(a.id) + '">' + esc(a.button) + "</button>" +
        '<button class="btn ghost" type="button" data-action="previewAction" data-id="' + esc(a.id) + '">Preview</button>' + side + "</div></article>";
    }).join("");
    $("actions").innerHTML = html || '<div class="empty"><strong>No actions</strong>' + (state.hasScan ? "Nothing in the last scan needs an update." : "Run a scan first.") + "</div>";
    $("actions-foot").textContent = state.online
      ? "packageHub.onlineLookups is on: advisory and publish data may come from nuget.org."
      : "Built from the last scan and local NuGet data. PackageHub made no network request.";
  }

  function renderFeeds() {
    const f = state.feeds;
    $("feed-count").textContent = String(f.items.length);
    let html = "";
    if (!f.listed) {
      html += '<div class="feeds-note">dotnet did not list the sources' + (f.sourceError ? ": " + esc(f.sourceError) : ".") + "</div>";
    } else if (f.items.length === 0) {
      html += '<div class="feeds-note">dotnet lists no package sources.</div>';
    }
    html += f.items.map((item) => {
      const failed = item.failures.length > 0;
      const status = !item.enabled ? "Disabled" : failed ? "Failed in the last scan" : "No failure seen";
      return '<div class="feed"><div class="feed-head"><span class="dot' + (failed ? " bad" : "") + '"></span><strong>' + esc(item.name) + '</strong><span class="muted">' + status + "</span></div>" +
        '<div class="feed-url">' + esc(item.url) + "</div>" +
        (failed ? "<ul>" + item.failures.map((x) => "<li><code>" + esc(x.code) + "</code> " + esc(x.message) + "</li>").join("") + "</ul>" : "") +
        (item.hints.length ? "<ul>" + item.hints.map((h) => "<li>" + esc(h) + "</li>").join("") + "</ul>" : "") + "</div>";
    }).join("");
    if (f.unmatched.length) {
      html += '<div class="feed"><strong>Other feed messages</strong><ul>' + f.unmatched.map((x) => "<li><code>" + esc(x.code) + "</code> " + esc(x.message) + "</li>").join("") + "</ul></div>";
    }
    if (f.credentialProviders.length) {
      html += '<div class="feeds-note">Credential providers found: ' + esc(f.credentialProviders.join(", ")) + "</div>";
    }
    html += '<div class="feeds-note">Feed health comes from dotnet output and the restore logs. PackageHub does not contact the feeds to check them.</div>';
    $("feeds").innerHTML = html;
  }

  function renderTabs() {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("is-on", b.getAttribute("data-tab") === ui.tab));
    $("actions").classList.toggle("is-hidden", ui.tab !== "actions");
    $("feeds").classList.toggle("is-hidden", ui.tab !== "feeds");
  }

  // Projects ----------------------------------------------------------------
  function level(v, max) {
    if (!v) { return "l0"; }
    const r = v / max;
    return r > 0.75 ? "l4" : r > 0.5 ? "l3" : r > 0.25 ? "l2" : "l1";
  }
  function renderHeat() {
    const list = state.projects;
    const heat = $("heat");
    heat.style.setProperty("--projects", String(Math.max(1, list.length)));
    const max = (fn) => Math.max(1, ...list.map(fn));
    const mv = max((p) => p.vulnerable);
    const mo = max((p) => p.outdated);
    const md = max((p) => p.deprecated);
    heat.innerHTML = '<div class="heat-legend"><h2>Projects</h2><span class="muted">' + (list.length ? "Click a project to filter" : "No projects scanned") + "</span>" +
      '<span class="scale">0 <i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i> most</span></div>' +
      list.map((p) => '<div class="proj" role="button" tabindex="0" data-project="' + esc(p.name) + '">' +
        '<div class="proj-head">' + icon("proj", "sm") + "<strong>" + esc(p.name) + '</strong><span class="muted">' + p.direct + " direct</span></div>" +
        '<div class="cells"><span class="cell v ' + level(p.vulnerable, mv) + '">Vulnerable <b>' + p.vulnerable + "</b></span>" +
        '<span class="cell o ' + level(p.outdated, mo) + '">Outdated <b>' + p.outdated + "</b></span>" +
        '<span class="cell d ' + level(p.deprecated, md) + '">Deprecated <b>' + p.deprecated + "</b></span></div></div>").join("");
  }

  // Loading -----------------------------------------------------------------
  function renderSkeleton() {
    const widths = ["w60", "w80", "w50", "w70", "w40", "w90", "w60", "w50", "w70", "w80"];
    $("skel-rows").innerHTML = widths.map((w) =>
      '<div class="skel-row"><span class="sk"></span><span class="sk ' + w + '"></span><span class="sk w80"></span><span class="sk w60"></span><span class="sk h18"></span><span class="sk h18"></span><span class="sk w70"></span><span class="sk h18"></span></div>').join("");
    $("skel-actions").innerHTML = [0, 1, 2].map(() =>
      '<div class="act"><span class="sk w60"></span><span class="sk w90 mt"></span><span class="sk w70 mt"></span><span class="sk w100 h28 mt"></span><span class="sk w40 h28 mt"></span></div>').join("");
    $("kpis").innerHTML = ["vulnerable", "outdated", "deprecated", "feeds"].map((k) =>
      '<div class="card kpi" data-kpi-skeleton="' + k + '"><span class="kpi-icon sk"></span><span class="kpi-label"><span class="sk w40"></span></span><span class="kpi-value"><span class="sk w60 h22"></span></span><span class="kpi-side"></span></div>').join("");
    $("heat").innerHTML = '<div class="heat-legend"><h2>Projects</h2><span class="muted">Scanning…</span></div>' +
      [0, 1, 2, 3].map(() => '<div class="proj"><span class="sk w60"></span><div class="cells"><span class="sk h26"></span><span class="sk h26"></span><span class="sk h26"></span></div></div>').join("");
    $("scan-meta").textContent = "Running dotnet list package…";
  }

  function renderAll() {
    document.body.classList.remove("is-loading", "is-refreshing");
    renderHeader();
    renderKpis();
    renderHeat();
    renderTable();
    renderActions();
    renderFeeds();
    renderTabs();
  }

  // Events (delegated; the page has no inline handlers) ----------------------
  document.addEventListener("click", (event) => {
    const t = event.target instanceof Element ? event.target : null;
    if (!t || !state) {
      if (t && t.closest('[data-action="refresh"]')) { post({ command: "refresh" }); }
      return;
    }
    let el = t.closest("[data-action]");
    if (el) {
      event.preventDefault();
      event.stopPropagation();
      const action = el.getAttribute("data-action");
      const id = el.getAttribute("data-id") || "";
      switch (action) {
        case "refresh": post({ command: "refresh" }); break;
        case "clearFilter": ui.filter = null; save(); renderKpis(); renderTable(); break;
        case "showFeeds": ui.tab = "feeds"; save(); renderKpis(); renderTabs(); break;
        case "applyAction": post({ command: "applyAction", actionId: id }); break;
        case "previewAction": post({ command: "previewAction", actionId: id }); break;
        case "updatePackage": post({ command: "updatePackage", packageId: id, version: el.getAttribute("data-version") || "" }); break;
        case "showDependencies": post({ command: "showDependencies", packageId: id }); break;
        case "openAdvisory": post({ command: "openAdvisory", url: el.getAttribute("data-url") || "" }); break;
      }
      return;
    }
    if ((el = t.closest(".kpi[data-kpi]"))) {
      const k = el.getAttribute("data-kpi");
      if (k === "feeds") {
        ui.tab = ui.tab === "feeds" ? "actions" : "feeds";
      } else {
        ui.filter = ui.filter === k ? null : k;
      }
      save(); renderKpis(); renderTable(); renderTabs();
      return;
    }
    if ((el = t.closest(".tabs button[data-tab]"))) {
      ui.tab = el.getAttribute("data-tab") === "feeds" ? "feeds" : "actions";
      save(); renderKpis(); renderTabs();
      return;
    }
    if ((el = t.closest(".proj[data-project]"))) {
      const f = "project:" + el.getAttribute("data-project");
      ui.filter = ui.filter === f ? null : f;
      save(); renderKpis(); renderTable();
      return;
    }
    if ((el = t.closest("#kind-seg button"))) {
      ui.kind = el.getAttribute("data-kind") || "all";
      save(); renderTable();
      return;
    }
    if ((el = t.closest("th[data-sort]"))) {
      const s = el.getAttribute("data-sort");
      if (ui.sort === s) { ui.dir = -ui.dir; } else { ui.sort = s; ui.dir = s === "name" || s === "kind" ? 1 : -1; }
      save(); renderTable();
      return;
    }
    if ((el = t.closest("tr.row"))) {
      const id = el.getAttribute("data-id");
      ui.open = ui.open === id ? null : id;
      save(); renderTable();
    }
  });
  document.addEventListener("keydown", (event) => {
    const t = event.target;
    if ((event.key === "Enter" || event.key === " ") && t instanceof HTMLElement && t.matches("tr.row, .proj")) {
      event.preventDefault();
      t.click();
    }
  });
  const search = $("search");
  search.value = ui.q;
  search.addEventListener("input", () => {
    ui.q = search.value.trim();
    save();
    if (state) { renderTable(); }
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") { return; }
    if (message.type === "loading") {
      if (state) {
        document.body.classList.add("is-refreshing");
      } else {
        document.body.classList.add("is-loading");
        renderSkeleton();
      }
    } else if (message.type === "state" && message.state) {
      state = message.state;
      if (ui.open && !state.packages.some((p) => p.id === ui.open)) { ui.open = null; }
      renderAll();
    }
  });

  renderSkeleton();
  post({ command: "ready" });
})();
