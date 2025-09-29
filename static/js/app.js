// static/js/app.js
// Auto-height notes (fixed width), draggable, long-press to edit, persist height/content.
"use strict";

let currentBoardId = null;
let notes = {}; // id -> DOM element
let longPressTimer = null;
let longPressTriggered = false;
let activeNoteId = null;
let maxZ = 1; // track highest z-index so we can bring notes to front
let clipboardNote = null;
let lastClickPos = { x: 100, y: 100 }; // fallback default
let snapEnabled = false; // default off
let lastActiveNoteId = null;
let contextBoardId = null;  // Board ID for context menu actions
let LONGPRESS_MS = 400;
let snapGridSize = 20; // pixels to snap to
let mode = "edit"; // default

const insertItems = [
  { label: "✅ Checkbox", html: '<input type="checkbox"/>' },
  { label: "🔥 Fire Emoji", text: "🔥" },
  { label: "❤️ Heart", text: "❤️" },
  { label: "⚡ Lightning", text: "⚡" },
];

const menus = {
  tableMenu: {
    autoClose: false,   // stays open after click
    buttons: [
      { text: '+ Row', action: addRowBelow },
      { text: '+ Col', action: addColumnRight },
      { text: '– Row', action: deleteRow },
      { text: '– Col', action: deleteColumn },
    ]
  },
  noteMenu: {
    autoClose: true,    // closes after click
    buttons: [
      { text: 'Copy', action: copyNote },
      { text: 'Delete', action: deleteNote },
    ]
  },
  insertMenu: {
  autoClose: false, // stays open after insertion
  buttons: insertItems.map(item => ({
    text: item.label,
    action: () => {
      const selection = window.getSelection();
      if (!selection.rangeCount) return;

      const range = selection.getRangeAt(0);

      // Only insert if the cursor is inside a .note-content
      if (!range.startContainer.closest('.note-content')) {
        console.log("Cursor not in a note content, insertion cancelled.");
        return;
      }

      if (item.text) {
        range.deleteContents();
        range.insertNode(document.createTextNode(item.text));
      } else if (item.html) {
        const temp = document.createElement('div');
        temp.innerHTML = item.html;
        const frag = document.createDocumentFragment();
        Array.from(temp.childNodes).forEach(n => frag.appendChild(n));
        range.deleteContents();
        range.insertNode(frag);
      }

      selection.collapseToEnd(); // move cursor after insertion
    }
  }))
}
};

async function api(path, method = "GET", body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch("/api" + path, opts);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `API error ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const newBoardBtn = document.getElementById("newBoardBtn");
const deleteBoardBtn = document.getElementById("deleteBoardBtn");
const duplicateBoardBtn = document.getElementById("duplicateBoardBtn");
const renameBoardBtn = document.getElementById("renameBoardBtn");
const copyNoteBtn = document.getElementById("copyNoteBtn");
const pasteNoteBtn = document.getElementById("pasteNoteBtn");
const snapToggle = document.getElementById("snapToggle"); // toggle button in menu


// Extended Markdown → HTML converter (headings, lists, tables, bold, paragraphs)
function markdownToHtml(markdown) {
  if (!markdown) return "";

  const escapeHtml = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const splitRow = (line) => {
    // split on | and remove only leading/trailing empty entries created by
    // a leading/trailing pipe. Keep empty cells in the middle.
    const parts = line.split("|");
    let start = 0;
    let end = parts.length;
    if (parts.length > 0 && parts[0].trim() === "") start = 1;
    if (parts.length > 1 && parts[parts.length - 1].trim() === "") end = parts.length - 1;
    return parts.slice(start, end).map((p) => p.trim());
  };

  const isDelimiterRow = (parts) => {
    if (!parts || parts.length === 0) return false;
    // each part must be like --- or :---: or ---: or :--- (allow at least one dash)
    return parts.every((p) => /^:?-{1,}:?$/.test(p));
  };

  const cellAlignment = (sep) => {
    if (sep.startsWith(":") && sep.endsWith(":")) return "center";
    if (sep.startsWith(":")) return "left";
    if (sep.endsWith(":")) return "right";
    return "left";
  };

  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const htmlLines = [];
  let inList = false;
  let tableBuffer = [];

  const flushTableBuffer = () => {
    if (tableBuffer.length === 0) return;

    // Need at least 2 rows (header + delimiter) to be a table
    if (tableBuffer.length >= 2) {
      const headerParts = splitRow(tableBuffer[0]);
      const delimParts = splitRow(tableBuffer[1]);

      if (isDelimiterRow(delimParts) && headerParts.length > 0) {
        // table detected
        // compute alignments (based on delimiter row)
        const aligns = delimParts.map((d) => cellAlignment(d));

        htmlLines.push('<table class="md-table"><thead><tr>');
        headerParts.forEach((h, i) => {
          const content = escapeHtml(h).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
          const align = aligns[i] || "left";
          htmlLines.push(`<th style="text-align:${align}">${content}</th>`);
        });
        htmlLines.push("</tr></thead><tbody>");

        // body rows (starting from third row)
        for (let r = 2; r < tableBuffer.length; r++) {
          const rowParts = splitRow(tableBuffer[r]);
          htmlLines.push("<tr>");
          // make sure we produce same number of cells as headers
          for (let c = 0; c < headerParts.length; c++) {
            const raw = rowParts[c] === undefined ? "" : rowParts[c];
            const cell = escapeHtml(raw).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
            const align = aligns[c] || "left";
            htmlLines.push(`<td style="text-align:${align}">${cell}</td>`);
          }
          htmlLines.push("</tr>");
        }

        htmlLines.push("</tbody></table>");
        tableBuffer = [];
        return;
      }
    }

    // Not a table — output the buffered lines as normal paragraphs (preserve blank lines)
    for (const l of tableBuffer) {
      const trimmed = l.trim();
      if (trimmed === "") {
        htmlLines.push("");
      } else {
        const content = escapeHtml(trimmed).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        htmlLines.push(`<p>${content}</p>`);
      }
    }
    tableBuffer = [];
  };

  for (let rawLine of lines) {
    const line = rawLine.replace(/\s+$/, ""); // rtrim

    // Table candidate: line that contains pipes (we accept lines that contain at least one pipe)
    if (/\|/.test(line)) {
      // accumulate contiguous pipe lines into a table buffer
      tableBuffer.push(line);
      continue;
    } else {
      // if we hit a non-pipe line, flush the buffered table (if any)
      flushTableBuffer();
    }

    // Headings (#, ##, ###...)
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      let content = headingMatch[2];
      content = escapeHtml(content).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      htmlLines.push(`<h${level}>${content}</h${level}>`);
      continue;
    }

    // Lists (- item)
    if (/^- /.test(line)) {
      if (!inList) {
        htmlLines.push("<ul>");
        inList = true;
      }
      let content = line.replace(/^- /, "");
      content = escapeHtml(content).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      htmlLines.push(`<li>${content}</li>`);
      continue;
    } else if (inList) {
      htmlLines.push("</ul>");
      inList = false;
    }

    // Normal paragraph with bold
    if (line.trim()) {
      let content = escapeHtml(line).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      htmlLines.push(`<p>${content}</p>`);
    } else {
      htmlLines.push(""); // blank line = spacing
    }
  }

  // flush any remaining table buffer at EOF
  flushTableBuffer();
  if (inList) htmlLines.push("</ul>");

  return htmlLines.join("\n");
}

function findTableAndCell() {
  if (!activeNoteId) return null;
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;

  let node = sel.getRangeAt(0).startContainer;

  // If it's a text node → move up
  if (node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }

  const cell = node.closest("td, th");
  if (!cell) return null;

  const table = cell.closest("table");
  if (!table) return null;

  return { table, cell };
}


function addRowBelow() {
  const ctx = findTableAndCell();
  if (!ctx) {
    // No table → spawn a new one
    insertNewTable();
    return;
  }
  const { table, cell } = ctx;
  const row = cell.parentElement;
  const rowIndex = row.rowIndex; // includes thead rows
  const newRow = table.insertRow(rowIndex + 1);

  // Use column count from first row
  const colCount = table.rows[0].cells.length;
  for (let i = 0; i < colCount; i++) {
    const td = newRow.insertCell(i);
    td.innerHTML = "&nbsp;";
  }
}

function addColumnRight() {
  const ctx = findTableAndCell();
  if (!ctx) {
    // No table → spawn a new one
    insertNewTable();
    return;
  }
  const { table, cell } = ctx;
  const colIndex = cell.cellIndex;

  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r];
    const newCell = row.insertCell(colIndex + 1);
    newCell.innerHTML = r === 0 ? "<strong>Header</strong>" : "&nbsp;";
  }
}


// 🗑️ Delete the current row
function deleteRow() {
  const ctx = findTableAndCell();
  if (!ctx) return;

  const row = ctx.cell.parentElement;
  const tbody = row.parentElement;

  // Only delete if more than one row left
  if (tbody.rows.length > 1) {
    row.remove();
  } else {
    // If it's the last row → remove the whole table
    ctx.table.remove();
  }
}

// 🗑️ Delete the current column
function deleteColumn() {
  const ctx = findTableAndCell();
  if (!ctx) return;

  const cellIndex = ctx.cell.cellIndex;

  // Only delete if more than one column
  if (ctx.table.rows[0].cells.length > 1) {
    [...ctx.table.rows].forEach(r => {
      if (r.cells[cellIndex]) {
        r.deleteCell(cellIndex);
      }
    });
  } else {
    // If it was the only column → remove whole table
    ctx.table.remove();
  }
}

function insertNewTable() {
  if (!activeNoteId) return;
  const note = notes[activeNoteId];
  const editorDiv = note.querySelector(".note-content");

  const tableHtml = `
    <table class="md-table">
      <thead>
        <tr><th>Header</th></tr>
      </thead>
      <tbody>
        <tr><td>&nbsp;</td></tr>
      </tbody>
    </table>
  `;
  document.execCommand("insertHTML", false, tableHtml);
}



// Menu container logic
const menuContainer = document.getElementById('globalMenuContainer');
let currentOpenMenuId = null; // track currently open menu

document.querySelector('#actionSheet').addEventListener("click", (e) => {
  if (document.getElementsByClassName('sub-menu')) {
    menuContainer.style.display = 'none';
  };
  const trigger = e.target.closest(".menu-trigger");
  if (!trigger) return;

  menuContainer.style.display = 'none';
  menuContainer.innerHTML = '';

  const menuId = trigger.dataset.menu;
  const menuDef = menus[menuId];
  if (!menuDef) return;

    // If the same menu is already open, close it
  if (currentOpenMenuId === menuId) {
    menuContainer.style.display = 'none';
    currentOpenMenuId = null;
    return;
  }

  const menu = document.createElement('div');
  menu.classList.add('sub-menu');

  menuDef.buttons.forEach(b => {
    const btn = document.createElement('button');
    btn.textContent = b.text;
    btn.addEventListener('click', evt => {
      evt.stopPropagation();
      b.action();
      if (menuDef.autoClose) menuContainer.style.display = 'none';
    });
    menu.appendChild(btn);
  });

  menuContainer.appendChild(menu);
  menuContainer.style.display = 'block';
  currentOpenMenuId = menuId;


  // Position above trigger
  const rect = trigger.getBoundingClientRect();
  const addheight = document.getElementsByClassName('topbar')[0].offsetHeight;
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.top + addheight}px`;
});


// Hide menu if clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('#globalMenuContainer') && !e.target.closest('.menu-trigger')) {
    menuContainer.style.display = 'none';
  }
});


newBoardBtn.addEventListener("click", async () => {
  const name = prompt("Board name?", "Untitled");
  if (!name) return;

  try {
    // ✅ Include currentProjectId in the URL
    const res = await api(`/projects/${currentProjectId}/boards`, "POST", { name });

    // Reload boards and switch to the new one
    await loadBoards();
    selectBoard(res.id);
  } catch (err) {
    alert("Failed to create board");
    console.error(err);
  }
});


snapToggle.addEventListener("click", () => {
  if (snapToggle.checked) {
    snapEnabled = true;
    snapToggle.classList.toggle("active", snapEnabled);
  }
  else {
    snapEnabled = false;
  }
  loadNotes();
});

snapToggle.addEventListener("change", async (e) => {
  if (!currentBoardId) return;
  snapEnabled = Boolean(e.target.checked); // ✅ keep snapEnabled in sync
  try {
    await api(`/boards/${currentBoardId}`, "PATCH", { snapping: snapEnabled });
  } catch (err) {
    console.error("Failed to update snapping", err);
  }
});

document.getElementById("boards").addEventListener("pointerdown", (e) => {
  const tab = e.target.closest(".board-tab");
  if (!tab) return;

  let startX = e.clientX;
  let startY = e.clientY;
  longPressTriggered = false;

  longPressTimer = setTimeout(() => {
    contextBoardId = parseInt(tab.dataset.id);
    selectBoard(contextBoardId);
    showBoardContextMenu(tab, e.pageX, e.pageY);
    longPressTriggered = true;
  }, LONGPRESS_MS);

  const moveHandler = (moveEvent) => {
    const dx = Math.abs(moveEvent.clientX - startX);
    const dy = Math.abs(moveEvent.clientY - startY);
    const moveThreshold = 5; // small threshold in pixels
    if (dx > moveThreshold || dy > moveThreshold) {
      clearTimeout(longPressTimer);
      document.removeEventListener("pointermove", moveHandler);
      document.removeEventListener("pointerup", upHandler);
    }
  };

  const upHandler = () => {
    clearTimeout(longPressTimer);
    document.removeEventListener("pointermove", moveHandler);
    document.removeEventListener("pointerup", upHandler);
  };

  document.addEventListener("pointermove", moveHandler);
  document.addEventListener("pointerup", upHandler);
});


document.addEventListener("pointerup", () => {
  clearTimeout(longPressTimer);
});

function applyModeToNotes() {
  Object.values(notes).forEach((el) => {
    const editorDiv = el.querySelector(".note-content");
    const draghandles = el.querySelector(".drag-handle");
    if (!editorDiv) return;

    if (mode === "edit") {
      editorDiv.setAttribute("contenteditable", "true");
      editorDiv.style.touchAction = "none"; // disable gestures so text editing works properly
      editorDiv.style.userSelect = "text";
      draghandles.style.touchAction = "none";
    } else {
      editorDiv.setAttribute("contenteditable", "false");
      // ✅ Let the browser handle pinch-zoom + scroll normally
      editorDiv.style.touchAction = "auto";
      editorDiv.style.userSelect = "none";
      // editorDiv.style.pointerEvents = "none"; // disable all interactions
      draghandles.style.touchAction = "auto";
    }

    try {
      interact(el).draggable({ enabled: mode === "edit" });
      interact(el).resizable({ enabled: mode === "edit" });
    } catch (e) { }
  });
}


function showBoardContextMenu(tab, x, y) {
  const menu = document.getElementById("boardContextMenu");
  menu.classList.remove("hidden");

  // Position near the tab
  menu.style.left = x + "px";
  menu.style.top = y + "px";
}

function closeBoardContextMenu() {
  const menu = document.getElementById("boardContextMenu");
  menu.classList.add("hidden");
  contextBoardId = null;
}

// Hide when clicking outside
document.addEventListener("click", (e) => {
  const menu = document.getElementById("boardContextMenu");
  if (!menu.contains(e.target)) {
    menu.classList.add("hidden");
    contextBoardId = null;
  }
});

// Hook up menu buttons
document.getElementById("renameBoardFromMenuBtn").addEventListener("click", async () => {
  if (!contextBoardId) return;
  const newName = prompt("Enter new board name:", document.getElementsByClassName("board-tab active")[0].textContent);
  if (!newName) return;
  await api(`/boards/${contextBoardId}`, "PATCH", { name: newName });
  await loadBoards();
  selectBoard(contextBoardId);
  closeBoardContextMenu();
});

document.getElementById("deleteBoardFromMenuBtn").addEventListener("click", async () => {
  if (!contextBoardId) return;
  if (!confirm("Delete this board?")) return;
  await api(`/boards/${contextBoardId}`, "DELETE");
  await loadBoards();
  closeBoardContextMenu();
  const firstBoard = document.querySelector(".board-tab");
  if (firstBoard) {
    selectBoard(parseInt(firstBoard.dataset.id));
  }
});

document.getElementById("duplicateBoardFromMenuBtn").addEventListener("click", async () => {
  if (!contextBoardId) return;
  await api(`/boards/${contextBoardId}/duplicate`, "POST");
  await loadBoards();
  closeBoardContextMenu();
});

// Rename project from settings menu
const renameProjectBtn = document.getElementById("renameProjectFromMenuBtn");
if (renameProjectBtn) {
  renameProjectBtn.addEventListener("click", async () => {
    try {
      // Fetch current project info so we can prefill its name
      const project = await api(`/projects/${currentProjectId}`);
      const newName = prompt("Enter new project name:", project.name);
      if (!newName || newName.trim() === "") return;

      await api(`/projects/${currentProjectId}`, "PATCH", { name: newName });

      // Optionally: update UI
      document.title = newName; // update browser tab title
      const projectNameEl = document.getElementById("projectName");
      if (projectNameEl) projectNameEl.textContent = newName;

      alert("Project renamed successfully!");
    } catch (err) {
      console.error("Failed to rename project:", err);
      alert("Failed to rename project");
    }
  });
}

document.getElementById("moveBoardFromMenuBtn").addEventListener("click", async () => {
  if (!contextBoardId) return;

  try {
    // Fetch all projects so user can choose
    const projects = await api("/projects");
    const choices = projects.map(p => `${p.id}: ${p.name}`).join("\n");

    const input = prompt("Move board to project (enter ID):\n" + choices);
    if (!input) return;

    const targetId = parseInt(input);
    if (isNaN(targetId)) return alert("Invalid project ID");

    await api(`/boards/${contextBoardId}/move`, "PATCH", { project_id: targetId });

    alert("Board moved!");
    closeBoardContextMenu();

    // reload boards for the *current project only*
    await loadBoards();

  } catch (err) {
    console.error("Failed to move board", err);
    alert("Failed to move board");
  }
});


if (copyNoteBtn) copyNoteBtn.addEventListener("click", copyNote);
if (pasteNoteBtn) pasteNoteBtn.addEventListener("click", pasteNote);

// Initialize Pickr for board background color
const pickr = Pickr.create({
  el: "#bgColorPickerContainer",
  theme: "classic", // 'classic', 'monolith', or 'nano'
  swatches: [
    '#E8E7E7',
    '#FFE1E1',
    '#FFF0E1',
    '#FFFDE1',
    '#EBFFE1',
    '#E1FDFF',
    '#E1F4FF',
    '#EAE1FF',
    '#FEE1FF',
    '#FFE1F2',
  ],

  default: "#cfd6d8ff",
  components: {
    preview: true,
    opacity: true,
    hue: true,
    interaction: {
      hex: true,
      input: true,
      save: true,
    },
  },
});

pickr.on("change", async (color) => {
  if (!currentBoardId) return;
  const hex = color.toHEXA().toString();
  document.getElementById("boardArea").style.background = hex;

  try {
    await api(`/boards/${currentBoardId}`, "PATCH", {
      background_color: hex,
    });
  } catch (err) {
    console.error("Failed to save board color", err);
  }
  // ✅ Update the border of the active tab
  const tab = document.querySelector(`.board-tab[data-id='${currentBoardId}']`);
  if (tab) {
    tab.style.border = `4px solid ${hex}`;
  }
  pickr.applyColor();
});

// Put this inside window.onload or after DOM is ready
const noteColorPickr = Pickr.create({
  el: '#noteColorPickerContainer',
  theme: 'classic',
  default: '#FFF59D', // default note color
  swatches: [
    '#FB6E6E',
    '#FFBBBB',
    '#FFE3E3',
    '#FDAA52',
    '#FFCD9A',
    '#FFE8D1',
    '#FDEA52',
    '#FFF4A0',
    '#FFFAD1',
    '#B7EB40',
    '#D6F392',
    '#F1FFD2',
    '#41DBDB',
    '#B5EBEB',
    '#DBF5F5',
    '#51AFE7',
    '#ABD8F3',
    '#E6F6FF',
    '#B972F5',
    '#D4ABF7',
    '#EBDCF7',


  ],

  components: {
    preview: true,
    opacity: true,
    hue: true,
    interaction: {
      hex: true,
      input: true,
      save: true
    }
  }
});

// When a color is saved
noteColorPickr.on("change", async (color) => {
  if (!lastActiveNoteId) return;

  const hex = color.toHEXA().toString();
  const el = notes[lastActiveNoteId];
  if (el) el.style.background = hex;

  try {
    await api(`/notes/${lastActiveNoteId}`, "PATCH", { color: hex });
  } catch (err) {
    console.error("Failed to save note color", err);
  }

  noteColorPickr.applyColor();
});

// Set initial color when loading the board
async function updateBoardBackgroundColor(boardId) {
  const boards = await api(`/projects/${currentProjectId}/boards`);
  const board = boards.find((b) => b.id === boardId);
  if (board) {
    // bgColorPicker.value = board.background_color || "#FFFFFF";
    pickr.setColor(board.background_color || "#FFFFFF");
    document.getElementById("boardArea").style.background = board.background_color || "#FFFFFF";
  }
}


async function pasteNote() {
  if (!clipboardNote) {
    alert("No note copied yet");
    return;
  }
  if (!currentBoardId) return alert("Pick a board first");

  try {
    await api("/notes", "POST", {
      board_id: currentBoardId,
      x: lastClickPos.x,
      y: lastClickPos.y,
      width: clipboardNote.width,
      height: clipboardNote.height,
      color: clipboardNote.color,
      content: clipboardNote.content,
    });
    await loadNotes();
  } catch (err) {
    console.error("Failed to paste note", err);
  }
}


async function loadBoards() {
  const bs = await api(`/projects/${currentProjectId}/boards`);
  const container = document.getElementById("boards");
  container.innerHTML = "";
  bs.forEach((b) => {
    const el = document.createElement("div");
    el.className = "board-tab" + (currentBoardId === b.id ? " active" : "");
    el.textContent = b.name;
    el.dataset.id = b.id;

    // ✅ Add border color based on board background
    if (b.background_color) {
      el.style.border = `4px solid ${b.background_color}`;
    } else {
      el.style.border = "4px solid transparent";
    }

    el.onclick = (e) => {
      if (longPressTriggered) {
        e.stopImmediatePropagation();
        e.preventDefault();
        longPressTriggered = false; // reset so next click works
        return; // suppress normal click
      }
      selectBoard(b.id);
    };

    container.appendChild(el);
  });
}

async function createBoard() {
  const name = prompt("Board name") || "Untitled";
  const b = await api(`/projects/${currentProjectId}/boards`, "POST", { name });
  await selectBoard(b.id);
  await loadBoards();
}

async function selectBoard(id) {
  currentBoardId = id;

  // Save selected board in localStorage
  localStorage.setItem("lastBoardId", id);

  await loadBoards();

  const boards = await api(`/projects/${currentProjectId}/boards`);
  const current = boards.find(b => b.id === id);
  if (current) {
    snapEnabled = current.snapping;
    snapToggle.checked = snapEnabled;
    await loadNotes();
  }

  await updateBoardBackgroundColor(currentBoardId);
}

function _setElPositionSize(el, n) {
  el.style.left = (n.x ?? 50) + "px";
  el.style.top = (n.y ?? 50) + "px";
  // keep width static (frontend controlled)
  el.style.width = (n.width ?? 220) + "px";
  // initial height — will be adjusted by autoResize after mount
  el.style.height = (n.height ?? 30) + "px";
  el.style.background = n.color || "#FFF59D";
  el.style.zIndex = n.z_index || 1;
  const z = Number(n.z_index || 1);
  if (z > maxZ) maxZ = z;
}

function bringToFront(el, noteId) {
  maxZ += 1;
  el.style.zIndex = maxZ;
  // persist z-index (non-blocking)
  api("/notes/" + noteId, "PATCH", { z_index: maxZ }).catch(() => { });
}

function selectNote(el, id) {
  if (mode !== "edit") return;
  // remove highlight from all notes
  Object.values(notes).forEach((noteEl) => noteEl.classList.remove("selected"));
  // highlight current
  el.classList.add("selected");
  activeNoteId = id;
  lastActiveNoteId = id; // store it

  // Set color picker to current note color
  const currentColor = el.style.background || "#FFF59D";
  noteColorPickr.setColor(currentColor);
}

function deselectAllNotes() {
  Object.values(notes).forEach((el) => el.classList.remove("selected"));
  activeNoteId = null;
}

function createNoteElement(n) {
  const el = document.createElement("div");

  el.className = "note";
  el.dataset.id = n.id;

  _setElPositionSize(el, n);

  const editorDiv = document.createElement("div");
  editorDiv.className = "note-content";
  editorDiv.contentEditable = true;
  editorDiv.innerHTML = n.content || "";
  editorDiv.setAttribute("contenteditable", "true");

  editorDiv.addEventListener("focus", () => {
    el.classList.add("focused");
  });

  editorDiv.addEventListener("blur", () => {
    el.classList.remove("focused");
  });

  // Initialize MediumEditor
  const editor = new MediumEditor(editorDiv, {
    placeholder: { text: "..." },
    toolbar: {
      buttons: [
        "bold",
        "italic",
        "underline",
        "anchor",
        "h2",
        "h3",
        "justifyLeft",
        "justifyCenter",
        "justifyRight",
        "unorderedlist",
        "orderedlist",
      ],
    },
    paste: {
      forcePlainText: false,
    },

  }).subscribe("editableClick", function (e) {
    if (e.target.href) {
      window.open(e.target.href);
    }
  });
  editor.subscribe("editableClick", function (e) {
    if (e.target.href) {
      window.open(e.target.href, "_blank");
    }
  });
  editor.subscribe('editablePaste', function (event, editable) {
    const text = (event.clipboardData || window.clipboardData).getData('text/plain');
    if (text && text.trim().startsWith('<') && text.trim().endsWith('>')) {
      event.preventDefault();
      document.execCommand('insertHTML', false, text);
    }
  });
  // Paste handler that converts Markdown → HTML if detected
  editor.subscribe("editablePaste", function (event, editable) {
    const text = (event.clipboardData || window.clipboardData).getData("text/plain");

    // Detect Markdown: at least one heading/list/bold marker
    if (/^#{1,6}\s|^- |[*_]{2}.+?[*_]{2}/m.test(text)) {
      event.preventDefault();
      const html = markdownToHtml(text);
      document.execCommand("insertHTML", false, html);
    }
  });

  editorDiv.addEventListener("touchend", (e) => {
    const a = e.target.closest("a");
    if (a && a.href) {
      window.open(a.href, "_blank");
    }
  });

  editor.subscribe("editableInput", () => {
    editorDiv.querySelectorAll("a").forEach((a) => {
      a.setAttribute("contenteditable", "false");
    });
  });

  editorDiv.setAttribute("autocomplete", "off");
  editorDiv.setAttribute("autocorrect", "off");
  editorDiv.setAttribute("autocapitalize", "off");

  const handle = document.createElement("div");
  handle.className = "drag-handle";
  el.appendChild(handle);

  // 1️⃣ Clicking/tapping the note content selects the note (only in edit mode)
  editorDiv.addEventListener("pointerdown", (ev) => {
    // If we're in scroll mode, don't select — let the event bubble so the board can scroll.
    if (mode !== "edit") return;

    // In edit mode: behave like before
    bringToFront(el, n.id);
    selectNote(el, n.id);
    openActionSheet(n.id);
    activeNoteId = n.id;

    // prevent accidental page scroll while dragging text in edit mode
    // but don't call preventDefault in scroll mode (we returned above)
    // ev.preventDefault(); // optional — only if you find selection/scrolling conflicts
  });

  // 2️⃣ Clicking/tapping the drag handle also selects the note (only in edit mode)
  handle.addEventListener("pointerdown", (ev) => {
    if (mode !== "edit") return;

    bringToFront(el, n.id);
    selectNote(el, n.id);
    openActionSheet(n.id);
    activeNoteId = n.id;

    editorDiv.blur(); // blur to prevent text editing while dragging
  });

  // click/tap behavior:
  el.addEventListener("click", (ev) => {
    // If we're in scroll mode, ignore clicks entirely so notes are not selected.
    if (mode !== "edit") return;
    
    ev.stopPropagation();

    if (longPressTriggered || isScrolling) {
      longPressTriggered = false;
      return; // don't open action sheet
    }

    bringToFront(el, n.id);

    activeNoteId = n.id;
    selectNote(el, n.id);
    openActionSheet(n.id);
  });

  // 👉 blur textarea when starting drag
  handle.addEventListener("pointerdown", () => {
    editorDiv.blur();
  });

  // helpers: debounced persisters (per-note)
  const persistHeightDebounced = debounce(async (h) => {
    try {
      await api("/notes/" + n.id, "PATCH", { height: Math.round(h) });
    } catch (err) {
      console.error("persist height err", err);
    }
  }, 600);

  const saveContentDebounced = debounce(async () => {
    try {
      await api("/notes/" + n.id, "PATCH", { content: editorDiv.innerHTML });
    } catch (err) {
      console.error("persist content err", err);
    }
  }, 600);

  editorDiv.addEventListener("input", () => {
    autoResize(false);
    saveContentDebounced();
  });

  editorDiv.addEventListener("blur", async () => {
    try {
      await api("/notes/" + n.id, "PATCH", {
        content: editorDiv.innerHTML,
        height: Math.round(editorDiv.scrollHeight),
      });
    } catch (err) {
      console.error("Failed saving on blur", err);
    }
  });

  // Auto-resize function updates textarea height and parent .note height
  function autoResize(persist = false) {
    // UI update on next frame to avoid layout thrash
    requestAnimationFrame(() => {
      editorDiv.style.height = "auto"; // reset to measure
      const newTaHeight = editorDiv.scrollHeight; // content height (includes padding of textarea)
      editorDiv.style.height = newTaHeight + "px";

      // compute extra vertical space on parent (padding + borders)
      const cs = window.getComputedStyle(el);
      const padTop = parseFloat(cs.paddingTop) || 0;
      const padBottom = parseFloat(cs.paddingBottom) || 0;
      const bTop = parseFloat(cs.borderTopWidth) || 0;
      const bBottom = parseFloat(cs.borderBottomWidth) || 0;
      const extra = padTop + padBottom + bTop + bBottom;

      const newElHeight = Math.round(newTaHeight + extra);
      el.style.height = newElHeight + "px";

      if (persist) persistHeightDebounced(newTaHeight);
    });
  }

  // expose for global calls
  editorDiv.autoResize = autoResize;

  // If note contains images, wait for them to load and then resize.
  // We'll attach listeners after the element is in the DOM (below), but also
  // ensure we handle cached images.

  // Ensure blur persists immediately
  editorDiv.addEventListener("blur", async () => {
    autoResize(true);
    try {
      await api("/notes/" + n.id, "PATCH", {
        content: editorDiv.innerHTML,
        height: Math.round(editorDiv.scrollHeight),
      });
    } catch (err) {
      console.error("Failed saving on blur", err);
    }
  });

  el.addEventListener("pointerup", (e) => {
    clearTimeout(longPressTimer);
    try {
      el.releasePointerCapture(e.pointerId);
    } catch (err) { }
  });
  el.addEventListener("pointercancel", () => clearTimeout(longPressTimer));

  // click/tap behavior:
  el.addEventListener("click", (ev) => {
    if (mode !== "edit") return;

    ev.stopPropagation();
    if (longPressTriggered || isScrolling) {
      longPressTriggered = false;
      return; // don't open action sheet
    }

    bringToFront(el, n.id);

    activeNoteId = n.id;
    selectNote(el, n.id);
    openActionSheet(n.id);
    // }
  });

  el.appendChild(editorDiv);
  document.getElementById("boardArea").appendChild(el);
  notes[n.id] = el;

  // run initial auto-resize after element is in DOM so measurements are correct
  autoResize(false);
  // also persist if loaded content is taller than stored height
  if ((n.height || 0) < editorDiv.scrollHeight)
    persistHeightDebounced(editorDiv.scrollHeight);

  // --- IMAGE HANDLING: listen for images that finish loading later ---
  const attachImageListeners = (img) => {
    if (!img) return;
    if (img.complete) {
      // already loaded (cached) — trigger resize
      autoResize(false);
    } else {
      img.addEventListener('load', () => autoResize(false));
      img.addEventListener('error', () => autoResize(false));
    }
  };

  // Attach to existing images inside the note
  editorDiv.querySelectorAll('img').forEach(attachImageListeners);

  // Observe future mutations (e.g., paste adds images) and attach listeners
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'IMG') {
          attachImageListeners(node);
        } else {
          node.querySelectorAll && node.querySelectorAll('img').forEach(attachImageListeners);
        }
      }
    }
  });
  mo.observe(editorDiv, { childList: true, subtree: true });
  // store observer so it can be cleaned up if needed later
  editorDiv._imageObserver = mo;

  // Make draggable only (no horizontal resizing) to keep width static
  interact(el)
    .draggable({
      allowFrom: ".drag-handle", // only drag from handle
      // ignoreFrom: ".note-content",
      preventDefault: "always",

      inertia: false,
      modifiers: [
        interact.modifiers.restrictRect({
          restriction: "#boardArea", // stay inside board
          endOnly: true,
          elementRect: { top: 0, left: 0, bottom: 0, right: 0 },
        }),
        interact.modifiers.snap({
          targets: snapEnabled
            ? [interact.createSnapGrid({ x: snapGridSize, y: snapGridSize })]
            : [],
          range: snapEnabled ? snapGridSize : 0,
          relativePoints: [{ x: 0, y: 0 }],
        }),
      ],

      listeners: {
        start(event) {
          document.body.classList.add("dragging"); // disable text selection
          bringToFront(event.target, n.id);
        },
        move(event) {
          const target = event.target;
          const prevX = parseFloat(target.getAttribute("data-x")) || 0;
          const prevY = parseFloat(target.getAttribute("data-y")) || 0;
          const dx = prevX + event.dx;
          const dy = prevY + event.dy;
          target.style.transform = `translate(${dx}px, ${dy}px)`;
          target.setAttribute("data-x", dx);
          target.setAttribute("data-y", dy);
        },
        end: async (event) => {
          document.body.classList.remove("dragging"); // re-enable selection
          const t = event.target;
          const dx = parseFloat(t.getAttribute("data-x")) || 0;
          const dy = parseFloat(t.getAttribute("data-y")) || 0;
          const left = parseFloat(t.style.left || 0) + dx;
          const top = parseFloat(t.style.top || 0) + dy;
          t.style.left = left + "px";
          t.style.top = top + "px";
          t.style.transform = "none";
          t.removeAttribute("data-x");
          t.removeAttribute("data-y");
          const id = t.dataset.id;
          try {
            await api("/notes/" + id, "PATCH", { x: left, y: top });
          } catch (err) {
            console.error("Failed to persist drag position", err);
          }
        },
      },
      autoScroll: {
        container: document.getElementById("boardArea"),
        margin: 50, // how close to the edge before scrolling starts
        speed: 300, // px per second
      },
    })
    .resizable({
      edges: { left: false, right: true, bottom: false, top: false },
      inertia: false,
      preventDefault: "always",
      modifiers: [
        interact.modifiers.snapSize({
          targets: snapEnabled
            ? [
              interact.createSnapGrid({
                width: snapGridSize,
                height: snapGridSize,
              }),
            ]
            : [],
        }),
      ],
    })
    .on("resizemove", function (event) {
      const target = event.target;
      // update size
      const width = event.rect.width;
      const height = event.rect.height;
      // when resizing from left/top, event.deltaRect.left/top contains offset we must apply to position
      const left =
        parseFloat(target.style.left || 0) + (event.deltaRect.left || 0);
      const top =
        parseFloat(target.style.top || 0) + (event.deltaRect.top || 0);

      target.style.width = width + "px";
      target.style.height = height + "px";
      target.style.left = left + "px";
      target.style.top = top + "px";
    })
    .on("resizeend", async function (event) {
      const id = event.target.dataset.id;
      autoResize(true);
      try {
        await api("/notes/" + id, "PATCH", {
          width: parseFloat(event.target.style.width),
          height: parseFloat(event.target.style.height),
          x: parseFloat(event.target.style.left),
          y: parseFloat(event.target.style.top),
        });
      } catch (err) {
        console.error("Failed to persist resize", err);
      }
    });
}

function clearBoardArea() {
  const area = document.getElementById("boardArea");
  area.innerHTML = "";
  notes = {};
}

// Schedule global resize passes to account for images loading from the network.
// We'll run a quick pass on next paint, another after 1s, and a final one after 5s
// (the final pass will also persist heights).
function scheduleResizePasses() {
  // next paint
  requestAnimationFrame(() => {
    Object.values(notes).forEach((el) => {
      const editorDiv = el.querySelector('.note-content');
      if (editorDiv && typeof editorDiv.autoResize === 'function') {
        try { editorDiv.autoResize(false); } catch (e) { /* ignore */ }
      }
    });
  });

  // 1 second later — helpful for slow image loads
  setTimeout(() => {
    Object.values(notes).forEach((el) => {
      const editorDiv = el.querySelector('.note-content');
      if (editorDiv && typeof editorDiv.autoResize === 'function') {
        try { editorDiv.autoResize(false); } catch (e) { /* ignore */ }
      }
    });
  }, 1000);

  // 5 seconds later — final pass and persist heights
  setTimeout(() => {
    Object.values(notes).forEach((el) => {
      const editorDiv = el.querySelector('.note-content');
      if (editorDiv && typeof editorDiv.autoResize === 'function') {
        try { editorDiv.autoResize(true); } catch (e) { /* ignore */ }
      }
    });
  }, 5000);
}

async function loadNotes() {
  if (!currentBoardId) return;
  clearBoardArea();
  const data = await api(`/boards/${currentBoardId}/notes`);

  data.forEach(createNoteElement);

  // Add invisible note at bottom-right to enable scrolling
  const paddingNote = {
    id: 0, // database starts at 1, so 0 is safe dummy
    x: 2000, // adjust width of scrollable area
    y: 2000, // adjust height of scrollable area
    width: 1,
    height: 1,
    color: "transparent",
    dummy: true, // flag to skip full creation
  };
  createNoteElement(paddingNote);
  applyModeToNotes(); // 👈 ensure new notes respect mode

  // Run scheduled resize passes (next paint, 1s, 5s)
  scheduleResizePasses();
}

async function addNote() {
  if (!currentBoardId) return alert("Pick a board first");

  try {
    const newNote = await api("/notes", "POST", {
      board_id: currentBoardId,
      x: lastClickPos.x,
      y: lastClickPos.y,
      width: 220, // fixed width
      height: 15, // start small
      color: "#FFF59D",
      content: "",
    });

    // Make sure the new note appears where you clicked
    newNote.x = lastClickPos.x;
    newNote.y = lastClickPos.y;

    createNoteElement(newNote);

  } catch (err) {
    console.error("Failed creating note", err);
  }
}



async function copyNote() {
  if (!activeNoteId) return;

  const n = notes[activeNoteId];
  if (!n) return;

  // Capture properties of the note
  clipboardNote = {
    content: n.querySelector(".note-content").innerHTML,
    x: 0, // reset, we'll position on paste
    y: 0,
    width: parseFloat(n.style.width) || 220,
    height: parseFloat(n.style.height) || 30,
    color: n.style.background || "#FFF59D",
  };

  //   alert("Note copied! Switch boards and use Paste to insert.");
  closeActionSheet();
}


function openActionSheet(noteId) {
  if (mode !== "edit") return;
  activeNoteId = noteId;
  const sheet = document.getElementById("actionSheet");
  if (!sheet) return;
  sheet.classList.add("visible");
}

function closeActionSheet() {
  const sheet = document.getElementById("actionSheet");
  if (!sheet) return;
  sheet.classList.remove("visible");
  activeNoteId = null;
}


function changeNoteColor() {
  if (!lastActiveNoteId) return;

  const el = notes[lastActiveNoteId];
  if (!el) return;

  // Set current color as default in Pickr
  const currentColor = el.style.background || "#FFF59D";
  noteColorPickr.setColor(currentColor);

  // Show the picker
  noteColorPickr.show();
}

async function deleteNote() {
  if (!activeNoteId) return;

  const noteEl = notes[activeNoteId];
  const contentEl = noteEl.querySelector(".note-content");

  // Only prompt if the note is non-empty
  if (contentEl && contentEl.innerHTML.trim() !== "") {
    if (!confirm("Delete note?")) return;
  }

  try {
    await api("/notes/" + activeNoteId, "DELETE");
    closeActionSheet();
    await loadNotes();
  } catch (err) {
    console.error("Failed to delete", err);
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

const settingsBtn = document.getElementById("settingsBtn");
const settingsMenu = document.getElementById("settingsMenu");

settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  settingsMenu.classList.toggle("hidden");
});

// Close when clicking outside
window.addEventListener("click", () => {
  settingsMenu.classList.add("hidden");
});

window.addEventListener("click", (e) => {
  closeActionSheet();
  deselectAllNotes();
});

// Handle Esc key to cancel selection / close sheet
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeActionSheet();
    deselectAllNotes();
  }
  if (e.key === "n" && (e.ctrlKey || e.metaKey)) {
    addNote();
  }

  const tag = e.target.tagName;
  const isTextInput =
    tag === "INPUT" || tag === ".note-content" || e.target.isContentEditable;

  if (isTextInput) return; // skip hotkeys when typing

  if (e.key === "c" && (e.ctrlKey || e.metaKey)) {
    copyNote();
  }
  if (e.key === "v" && (e.ctrlKey || e.metaKey)) {
    pasteNote();
  }

  if (e.key === "Backspace" || e.key === "Delete") {
    if (
      e.target.tagName === "INPUT" ||
      e.target.tagName === ".note-content" ||
      e.target.isContentEditable
    ) {
      return; // don’t trigger delete
    }
    deleteNote();
  }
});

const boardArea = document.getElementById("boardArea");

boardArea.addEventListener("click", (e) => {
  // ignore if clicking a note or child of a note
  if (e.target.closest(".note")) return;

  const rect = boardArea.getBoundingClientRect();
  lastClickPos = {
    x: e.clientX - rect.left + boardArea.scrollLeft,
    y: e.clientY - rect.top + boardArea.scrollTop,
  };
});

const actionSheet = document.getElementById("actionSheet");
actionSheet.addEventListener("click", (e) => {
  e.stopPropagation(); // Prevent window click from firing
});

let isScrolling = false;

boardArea.addEventListener("pointerdown", () => {
  isScrolling = false;
});

boardArea.addEventListener("pointermove", () => {
  isScrolling = true;
});

boardArea.addEventListener("pointerup", () => {
  setTimeout(() => isScrolling = false, 50); // reset shortly after pointer up
});

window.addEventListener("load", async () => {

  const addBoardBtn = document.getElementById("addBoardBtn");
  if (addBoardBtn) addBoardBtn.addEventListener("click", createBoard);

  if (!document.getElementById("addNoteBtn")) {
    if (addBoardBtn)
      addBoardBtn.insertAdjacentHTML(
        "afterend",
        '<button id="addNoteBtn">+ Note</button>'
      );
  }
  const addNoteBtn = document.getElementById("addNoteBtn");
  if (addNoteBtn) addNoteBtn.addEventListener("click", addNote);

  const deleteNoteBtn = document.getElementById("deleteNoteBtn");
  if (deleteNoteBtn) deleteNoteBtn.addEventListener("click", deleteNote);

  await loadBoards();
  const boards = await api(`/projects/${currentProjectId}/boards`);

  // Try to restore last selected board
  const lastBoardId = localStorage.getItem("lastBoardId");
  if (lastBoardId && boards.find(b => b.id == lastBoardId)) {
    await selectBoard(parseInt(lastBoardId));
  } else if (boards.length) {
    await selectBoard(boards[0].id);
  }
});


const modeBtn = document.getElementById("modeToggle");
modeBtn.onclick = () => {
  if (mode === "scroll") {
    mode = "edit";
    modeBtn.textContent = "✏️";
  } else {
    mode = "scroll";
    modeBtn.textContent = "✋";
  }
  applyModeToNotes(); // 👈 update all notes
};

modeBtn.onclick = () => {
  if (mode === "scroll") {
    mode = "edit";
    modeBtn.textContent = "✏️";
  } else {
    mode = "scroll";
    modeBtn.textContent = "✋";
  }

  localStorage.setItem("lastMode", mode); // ✅ persist mode
  applyModeToNotes();
};

window.addEventListener("load", async () => {
  // Restore last mode if exists
  const savedMode = localStorage.getItem("lastMode");
  if (savedMode) {
    mode = savedMode;
    if (mode === "edit") {
      modeBtn.textContent = "✏️";
    } else {
      modeBtn.textContent = "✋";
    }
  }

  applyModeToNotes();
});

function updateVH() {
  document.documentElement.style.setProperty(
    "--vh",
    window.innerHeight * 0.01 + "px"
  );
}
window.addEventListener("resize", updateVH);
updateVH();
