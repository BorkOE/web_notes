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
let snapEnabled = true; // default off
let lastActiveNoteId = null;

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


newBoardBtn.addEventListener("click", async () => {
  const name = prompt("Board name?", "Untitled");
  try {
    const res = await api("/boards", "POST", { name });
    console.log("Created board", res);
    // Reload boards and switch to the new one
    await loadBoards();
    selectBoard(res.id);
  } catch (err) {
    alert("Failed to create board");
    console.error(err);
  }
});

deleteBoardBtn.addEventListener("click", async () => {
  if (!currentBoardId) return;

  if (!confirm("Delete this board (and all its notes)?")) return;

  try {
    await api(`/boards/${currentBoardId}`, "DELETE");
    await loadBoards();

    // fallback: select the first board
    const firstBoard = document.querySelector(".board-tab");
    if (firstBoard) {
      selectBoard(parseInt(firstBoard.dataset.id));
    }
  } catch (err) {
    alert("Failed to delete board");
    console.error(err);
  }
});

duplicateBoardBtn.addEventListener("click", async () => {
  if (!currentBoardId) return;

  try {
    const res = await api(`/boards/${currentBoardId}/duplicate`, "POST");
    await loadBoards();
    selectBoard(res.id); // switch to the new copy immediately
  } catch (err) {
    alert("Failed to duplicate board");
    console.error(err);
  }
});

renameBoardBtn.addEventListener("click", async () => {
  if (!currentBoardId) return;

  const newName = prompt(
    "Enter new board name:",
    document.getElementsByClassName("board-tab active")[0].textContent
  );
  if (!newName) return;

  try {
    var res = await api(`/boards/${currentBoardId}`, "PATCH", { name: newName });
    console.log(res);
    await loadBoards();
    // console.log("Renamed board to", newName);
    selectBoard(currentBoardId); // stay on the renamed board
  } catch (err) {
    alert("Failed to rename board");
    console.error(err);
  }
});

snapToggle.addEventListener("click", () => {
    if (snapToggle.checked){
        snapEnabled = true;
        snapToggle.classList.toggle("active", snapEnabled);
    }
    else{
        snapEnabled = false;
    }
  loadNotes();
});

if (copyNoteBtn) copyNoteBtn.addEventListener("click", copyNote);
if (pasteNoteBtn) pasteNoteBtn.addEventListener("click", pasteNote);

// Initialize Pickr for board background color
const pickr = Pickr.create({
    el: "#bgColorPickerContainer",
    theme: "classic", // 'classic', 'monolith', or 'nano'
    swatches: [
        'rgba(244, 67, 54, 1)',
        'rgba(233, 30, 99, 0.95)',
        'rgba(156, 39, 176, 0.9)',
        'rgba(103, 58, 183, 0.85)',
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

pickr.on("save", async (color) => {
    if (!currentBoardId) return;
    const hex = color.toHEXA().toString();
    document.getElementById("boardArea").style.background = hex;

    try {
        await api(`/boards/${currentBoardId}`, "PATCH", {
        background_color: hex,
        });
        console.log("Board color updated to", hex);
    } catch (err) {
        console.error("Failed to save board color", err);
    }
    pickr.hide();
});

// Put this inside window.onload or after DOM is ready
const noteColorPickr = Pickr.create({
  el: '#noteColorPickerContainer',
  theme: 'classic', 
  default: '#FFF59D', // default note color
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

// Set initial color when loading the board
async function updateBoardBackgroundColor(boardId) {
    const boards = await api("/boards");
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
  const bs = await api("/boards");
  const container = document.getElementById("boards");
  container.innerHTML = "";
  bs.forEach((b) => {
    const el = document.createElement("div");
    el.className = "board-tab" + (currentBoardId === b.id ? " active" : "");
    el.textContent = b.name;
    el.dataset.id = b.id;
    el.onclick = () => {
      selectBoard(b.id);
    };
    container.appendChild(el);
  });
}

async function createBoard() {
  const name = prompt("Board name") || "Untitled";
  const b = await api("/boards", "POST", { name });
  await selectBoard(b.id);
  await loadBoards();
}

async function selectBoard(id) {
  currentBoardId = id;
  await loadNotes();
  await loadBoards();

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
  api("/notes/" + noteId, "PATCH", { z_index: maxZ }).catch(() => {});
}

function selectNote(el, id) {
  // remove highlight from all notes
  Object.values(notes).forEach((noteEl) => noteEl.classList.remove("selected"));
  // highlight current
  el.classList.add("selected");
  activeNoteId = id;
  lastActiveNoteId = id; // store it
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

  const ta = document.createElement("textarea");
  ta.value = n.content || "";
  ta.setAttribute("autocomplete", "off");
  ta.setAttribute("autocorrect", "off");
  ta.setAttribute("autocapitalize", "off");

  const handle = document.createElement("div");
  handle.className = "drag-handle";
  el.appendChild(handle);
  el.appendChild(ta);

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
      await api("/notes/" + n.id, "PATCH", { content: ta.value });
    } catch (err) {
      console.error("persist content err", err);
    }
  }, 400);

  // Auto-resize function updates textarea height and parent .note height
  function autoResize(persist = false) {
    // UI update on next frame to avoid layout thrash
    requestAnimationFrame(() => {
      ta.style.height = "auto"; // reset to measure
      const newTaHeight = ta.scrollHeight; // content height (includes padding of textarea)
      ta.style.height = newTaHeight + "px";

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

  // Save content & height when user types, but do UI resize immediately
  ta.addEventListener("input", () => {
    autoResize(false); // immediate visual update
    saveContentDebounced(); // debounced content save
    persistHeightDebounced(ta.scrollHeight); // schedule height save (debounced inside)
  });

  // Ensure blur persists immediately
  ta.addEventListener("blur", async () => {
    autoResize(true);
    try {
      await api("/notes/" + n.id, "PATCH", {
        content: ta.value,
        height: Math.round(ta.scrollHeight),
      });
    } catch (err) {
      console.error("Failed saving on blur", err);
    }
  });

  el.addEventListener("pointerup", (e) => {
    clearTimeout(longPressTimer);
    try {
      el.releasePointerCapture(e.pointerId);
    } catch (err) {}
  });
  el.addEventListener("pointercancel", () => clearTimeout(longPressTimer));

  // click/tap behavior:
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (longPressTriggered) {
      longPressTriggered = false;
      return;
    }

    bringToFront(el, n.id);

    if (activeNoteId === n.id) {
      // already selected -> second click => edit
      ta.focus();
    } else {
      // first click => just select
      activeNoteId = n.id;
      selectNote(el, n.id);
      openActionSheet(n.id);
    }
  });

  el.appendChild(ta);
  document.getElementById("boardArea").appendChild(el);
  notes[n.id] = el;

  // run initial auto-resize after element is in DOM so measurements are correct
  autoResize(false);
  // also persist if loaded content is taller than stored height
  if ((n.height || 0) < ta.scrollHeight)
    persistHeightDebounced(ta.scrollHeight);

  const snapGridSize = 20; // pixels to snap to
  // Make draggable only (no horizontal resizing) to keep width static
  interact(el)
    .draggable({
      allowFrom: ".drag-handle", // only drag from handle
      inertia: false,
      modifiers: [
        interact.modifiers.restrictRect({
          restriction: "#boardArea", // stay inside board
          endOnly: true,
          elementRect: { top: 0, left: 0, bottom: 1, right: 0 },
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

      ignoreFrom: "textarea",
      preventDefault: "always",
    })
    .resizable({
      edges: { left: false, right: true, bottom: false, top: false },
      inertia: false,
      preventDefault: "always",
      modifiers: [
      interact.modifiers.snapSize({
        targets: snapEnabled
          ? [interact.createSnapGrid({ width: snapGridSize, height: snapGridSize })]
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

async function loadNotes() {
  if (!currentBoardId) return;
  clearBoardArea();
  const data = await api("/boards/" + currentBoardId + "/notes");
  data.forEach(createNoteElement);
}

async function addNote() {
  if (!currentBoardId) return alert("Pick a board first");

  try {
    await api("/notes", "POST", {
      board_id: currentBoardId,
      x: lastClickPos.x,
      y: lastClickPos.y,
      width: 220, // fixed width
      height: 15, // start small
      color: "#FFF59D",
      content: "",
    });
    await loadNotes();
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
    content: n.querySelector("textarea").value,
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
  activeNoteId = noteId;
  const sheet = document.getElementById("actionSheet");
  if (!sheet) return;
  sheet.classList.add("visible");
  //   sheet.classList.remove("hidden");
}

function closeActionSheet() {
  const sheet = document.getElementById("actionSheet");
  if (!sheet) return;
  // sheet.classList.add("hidden");
  sheet.classList.remove("visible");
  activeNoteId = null;
}

// async function changeColor() {
//   if (!activeNoteId) return;
//   const palette = [
//     "#FFF59D",
//     "#FFECB3",
//     "#FFE0B2",
//     "#FFCDD2",
//     "#C8E6C9",
//     "#BBDEFB",
//     "#E1BEE7",
//   ];
//   const choice = prompt(
//     "Enter hex color or type a number:\n" +
//       palette.map((c, i) => `${i + 1}: ${c}`).join("\n"),
//     palette[0]
//   );
//   if (!choice) return;
//   let col = choice.trim();
//   if (/^[1-9]$/.test(col)) col = palette[Number(col) - 1];
//   if (!/^#([0-9A-F]{3}){1,2}$/i.test(col)) {
//     alert("Invalid hex");
//     return;
//   }
//   try {
//     await api("/notes/" + activeNoteId, "PATCH", { color: col });
//     const el = notes[activeNoteId];
//     if (el) el.style.background = col;
//   } catch (err) {
//     console.error("Failed to change color", err);
//   } finally {
//     closeActionSheet();
//   }
// }

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

// When a color is saved
noteColorPickr.on("save", async (color) => {
  if (!lastActiveNoteId) return;
  console.log("Selected color:", color.toHEXA().toString());

  const hex = color.toHEXA().toString();
  const el = notes[lastActiveNoteId];
  if (el) el.style.background = hex;

  try {
    await api(`/notes/${lastActiveNoteId}`, "PATCH", { color: hex });
  } catch (err) {
    console.error("Failed to save note color", err);
  }

  noteColorPickr.hide();
  closeActionSheet();
});


async function deleteNote() {
  if (!activeNoteId) return;
  if (!confirm("Delete note?")) return;
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

//   const changeColorBtn = document.getElementById("changeColorBtn");
//   if (changeColorBtn) changeColorBtn.addEventListener("click", changeColor);
  const deleteNoteBtn = document.getElementById("deleteNoteBtn");
  if (deleteNoteBtn) deleteNoteBtn.addEventListener("click", deleteNote);

  await loadBoards();
  const bs = await api("/boards");
  if (bs && bs.length) {
    if (!currentBoardId) await selectBoard(bs[0].id);
    else await loadNotes();
  }
});

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
    tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable;

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
      e.target.tagName === "TEXTAREA" ||
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


function updateVH() {
  document.documentElement.style.setProperty(
    "--vh",
    window.innerHeight * 0.01 + "px"
  );
}
window.addEventListener("resize", updateVH);
updateVH();
