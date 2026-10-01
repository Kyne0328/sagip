#!/usr/bin/env python3
"""Generate SAGIP documentation SVG figures from semantic JSON specifications.

This tool intentionally uses only the Python standard library. The JSON files are
semantic sources: they describe entities, flows, evidence states, and timeline
data. Grid row/column hints are allowed, but the specs do not carry absolute
pixel coordinates for individual objects.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import textwrap
import xml.etree.ElementTree as ET
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]

PALETTE = {
    "ink": "#17202a",
    "muted": "#5f6b76",
    "line": "#334e68",
    "blue": "#eaf2fb",
    "blue_stroke": "#2d5f8b",
    "green": "#eaf7ee",
    "green_stroke": "#2f6b45",
    "amber": "#fff5df",
    "amber_stroke": "#9a6a18",
    "purple": "#f4effb",
    "purple_stroke": "#6d4c8d",
    "red": "#fdeeee",
    "red_stroke": "#984242",
    "gray": "#f5f7f9",
    "gray_stroke": "#6b7785",
    "white": "#ffffff",
    "grid": "#d5dde5",
}

STATUS_STYLE = {
    "implemented": ("blue", "blue_stroke"),
    "automated_verified": ("blue", "blue_stroke"),
    "emulator_verified": ("purple", "purple_stroke"),
    "physical_device_verified": ("green", "green_stroke"),
    "live_backend_verified": ("green", "green_stroke"),
    "pending_field_validation": ("amber", "amber_stroke"),
    "production_gated": ("red", "red_stroke"),
    "not_operational": ("gray", "gray_stroke"),
    "data_store": ("green", "green_stroke"),
    "component": ("blue", "blue_stroke"),
    "protocol": ("amber", "amber_stroke"),
    "backend": ("purple", "purple_stroke"),
    "responder": ("green", "green_stroke"),
    "user": ("gray", "gray_stroke"),
    "neutral": ("gray", "gray_stroke"),
}


def esc(value: object) -> str:
    return escape(str(value), {'"': "&quot;"})


def lines_for(text: str, max_chars: int) -> list[str]:
    parts: list[str] = []
    for paragraph in str(text).split("\n"):
        if not paragraph:
            parts.append("")
        else:
            parts.extend(textwrap.wrap(paragraph, width=max_chars, break_long_words=False, break_on_hyphens=False) or [""])
    return parts


def svg_text(
    x: float,
    y: float,
    text: str,
    *,
    size: int = 24,
    weight: int = 400,
    anchor: str = "start",
    fill: str | None = None,
    max_chars: int | None = None,
    line_height: int | None = None,
    italic: bool = False,
) -> str:
    fill = fill or PALETTE["ink"]
    style = " font-style=\"italic\"" if italic else ""
    if max_chars is None:
        return (
            f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}" '
            f'font-family="Arial, Helvetica, sans-serif" font-size="{size}" '
            f'font-weight="{weight}" fill="{fill}"{style}>{esc(text)}</text>'
        )
    lines = lines_for(text, max_chars)
    lh = line_height or int(size * 1.25)
    chunks = [
        f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}" '
        f'font-family="Arial, Helvetica, sans-serif" font-size="{size}" '
        f'font-weight="{weight}" fill="{fill}"{style}>'
    ]
    for i, line in enumerate(lines):
        dy = 0 if i == 0 else lh
        chunks.append(f'<tspan x="{x:.1f}" dy="{dy}">{esc(line)}</tspan>')
    chunks.append("</text>")
    return "".join(chunks)


def box(
    x: float,
    y: float,
    w: float,
    h: float,
    *,
    fill: str,
    stroke: str,
    radius: int = 16,
    stroke_width: int = 3,
    dash: str | None = None,
) -> str:
    dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
    return (
        f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" '
        f'rx="{radius}" fill="{fill}" stroke="{stroke}" stroke-width="{stroke_width}"{dash_attr}/>'
    )


def line(
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    *,
    stroke: str | None = None,
    width: int = 3,
    arrow: bool = False,
    dash: str | None = None,
) -> str:
    stroke = stroke or PALETTE["line"]
    arrow_attr = ' marker-end="url(#arrow)"' if arrow else ""
    dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
    return (
        f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
        f'stroke="{stroke}" stroke-width="{width}" fill="none"{arrow_attr}{dash_attr}/>'
    )


def polyline(points: list[tuple[float, float]], *, arrow: bool = False, dash: str | None = None, width: int = 3) -> str:
    pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
    arrow_attr = ' marker-end="url(#arrow)"' if arrow else ""
    dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<polyline points="{pts}" fill="none" stroke="{PALETTE["line"]}" stroke-width="{width}"{arrow_attr}{dash_attr}/>'


def style_for(key: str | None) -> tuple[str, str]:
    fill_key, stroke_key = STATUS_STYLE.get(key or "neutral", STATUS_STYLE["neutral"])
    return PALETTE[fill_key], PALETTE[stroke_key]


def svg_header(width: int, height: int, title: str, subtitle: str | None = None) -> list[str]:
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        "<defs>",
        '<marker id="arrow" markerWidth="12" markerHeight="12" refX="10" refY="4" orient="auto" markerUnits="strokeWidth">',
        f'<path d="M0,0 L0,8 L11,4 z" fill="{PALETTE["line"]}"/>',
        "</marker>",
        "</defs>",
        f'<rect width="100%" height="100%" fill="{PALETTE["white"]}"/>',
        svg_text(width / 2, 62, title, size=54, weight=700, anchor="middle"),
    ]
    if subtitle:
        out.append(svg_text(width / 2, 108, subtitle, size=30, anchor="middle", fill=PALETTE["muted"], max_chars=120, line_height=34))
    return out


def add_footer_notes(out: list[str], width: int, height: int, notes: list[str]) -> None:
    if not notes:
        return
    y = height - 48 - (len(notes) - 1) * 34
    for note in notes:
        out.append(svg_text(width / 2, y, note, size=28, anchor="middle", fill=PALETTE["muted"], max_chars=135, line_height=31))
        y += 34


def render_flow(spec: dict) -> str:
    width = int(spec.get("width", 2400))
    height = int(spec.get("height", 1500))
    out = svg_header(width, height, spec["title"], spec.get("subtitle"))

    grid = spec.get("grid", {})
    rows = int(grid.get("rows", 6))
    cols = int(grid.get("cols", 4))
    left, right, top, bottom = 80, 80, 175, 190
    col_w = (width - left - right) / cols
    row_h = (height - top - bottom) / rows
    gap_x, gap_y = 32, 28

    nodes: dict[str, dict] = {}
    for node in spec["nodes"]:
        row = int(node["row"])
        col = int(node["col"])
        colspan = int(node.get("colspan", 1))
        rowspan = int(node.get("rowspan", 1))
        x = left + col * col_w + gap_x / 2
        y = top + row * row_h + gap_y / 2
        w = col_w * colspan - gap_x
        h = row_h * rowspan - gap_y
        shape = node.get("shape", "box")
        fill, stroke = style_for(node.get("kind") or node.get("status"))
        dash = "10 7" if node.get("dashed") else None

        if shape == "external_entity":
            fill, stroke = style_for("user")
            out.append(box(x, y, w, h, fill=fill, stroke=stroke, radius=2, dash=dash))
            title_x = x + w / 2
            title_y = y + h / 2 - 8
            title_anchor = "middle"
        elif shape == "process":
            fill, stroke = style_for("component")
            out.append(box(x, y, w, h, fill=fill, stroke=stroke, radius=28, dash=dash))
            number = node.get("number")
            if number:
                badge_w, badge_h = 92, 48
                out.append(box(x + 14, y + 14, badge_w, badge_h, fill=PALETTE["white"], stroke=stroke, radius=8, stroke_width=2))
                out.append(svg_text(x + 14 + badge_w / 2, y + 47, number, size=27, weight=700, anchor="middle", fill=stroke))
            title_x = x + w / 2
            title_y = y + 82
            title_anchor = "middle"
        elif shape == "data_store":
            fill, stroke = style_for("data_store")
            out.append(box(x, y, w, h, fill=fill, stroke=stroke, radius=2, dash=dash))
            id_band = min(92, w * 0.18)
            out.append(line(x + id_band, y, x + id_band, y + h, stroke=stroke, width=3))
            number = node.get("number", "")
            if number:
                out.append(svg_text(x + id_band / 2, y + h / 2 + 10, number, size=30, weight=700, anchor="middle", fill=stroke))
            title_x = x + id_band + (w - id_band) / 2
            title_y = y + 72
            title_anchor = "middle"
        else:
            out.append(box(x, y, w, h, fill=fill, stroke=stroke, dash=dash))
            title_x = x + w / 2
            title_y = y + 52
            title_anchor = "middle"

        title_lines = lines_for(node["label"], 24 if colspan == 1 else 42)
        for i, t in enumerate(title_lines[:2]):
            out.append(svg_text(title_x, title_y + i * 44, t, size=38 if shape != "box" else 42, weight=700, anchor=title_anchor))
        cursor = title_y + min(2, len(title_lines)) * 44 + 8
        detail = node.get("detail")
        if detail:
            detail_x = title_x
            for i, t in enumerate(lines_for(detail, 27 if colspan == 1 else 45)[:2]):
                out.append(svg_text(detail_x, cursor + i * 32, t, size=27, anchor="middle", fill=PALETTE["muted"]))
        badge = node.get("badge")
        if badge:
            badge_fill, badge_stroke = style_for(node.get("status"))
            bw = min(w - 36, max(250, len(badge) * 15))
            bh = 44
            bx = x + (w - bw) / 2
            by = y + h - bh - 16
            out.append(box(bx, by, bw, bh, fill=badge_fill, stroke=badge_stroke, radius=10, stroke_width=2))
            out.append(svg_text(bx + bw / 2, by + 31, badge, size=25, weight=700, anchor="middle", fill=badge_stroke))
        nodes[node["id"]] = {"x": x, "y": y, "w": w, "h": h}

    for edge in spec.get("edges", []):
        a = nodes[edge["from"]]
        b = nodes[edge["to"]]
        route = edge.get("route", "auto")
        dashed = "8 7" if edge.get("dashed") else None

        acx, acy = a["x"] + a["w"] / 2, a["y"] + a["h"] / 2
        bcx, bcy = b["x"] + b["w"] / 2, b["y"] + b["h"] / 2

        if route == "return":
            y_bus = height - 120
            pts = [
                (acx, a["y"] + a["h"]),
                (acx, y_bus),
                (bcx, y_bus),
                (bcx, b["y"] + b["h"]),
            ]
        elif abs(acx - bcx) < 20:
            pts = [(acx, a["y"] + a["h"]), (bcx, b["y"])]
        elif bcx > acx:
            start = (a["x"] + a["w"], acy)
            end = (b["x"], bcy)
            mid_x = (start[0] + end[0]) / 2
            pts = [start, (mid_x, start[1]), (mid_x, end[1]), end]
        else:
            start = (a["x"], acy)
            end = (b["x"] + b["w"], bcy)
            mid_x = (start[0] + end[0]) / 2
            pts = [start, (mid_x, start[1]), (mid_x, end[1]), end]

        out.append(polyline(pts, arrow=True, dash=dashed, width=3))
        label = edge.get("label")
        if label and spec.get("show_edge_labels", False):
            mx = sum(p[0] for p in pts) / len(pts) + float(edge.get("label_dx", 0))
            my = sum(p[1] for p in pts) / len(pts) - 10 + float(edge.get("label_dy", 0))
            out.append(svg_text(mx, my, label, size=27, anchor="middle", fill=PALETTE["muted"], max_chars=int(edge.get("label_max_chars", 24)), line_height=30))

    legend = spec.get("legend", [])
    if legend:
        x = 90
        y = height - 82
        for item in legend:
            fill, stroke = style_for(item["status"])
            out.append(box(x, y - 24, 34, 24, fill=fill, stroke=stroke, radius=5, stroke_width=2))
            out.append(svg_text(x + 46, y - 4, item["label"], size=25, fill=PALETTE["muted"]))
            x += 46 + len(item["label"]) * 9 + 35

    add_footer_notes(out, width, height, spec.get("notes", []))
    out.append("</svg>")
    return "\n".join(out)


def render_erd(spec: dict) -> str:
    width = int(spec.get("width", 2600))
    height = int(spec.get("height", 1800))
    out = svg_header(width, height, spec["title"], spec.get("subtitle"))

    grid = spec.get("grid", {})
    rows = int(grid.get("rows", 4))
    cols = int(grid.get("cols", 3))
    left, right, top, bottom = 55, 55, 175, 145
    col_w = (width - left - right) / cols
    row_h = (height - top - bottom) / rows
    gap_x, gap_y = 28, 24
    entity_pos: dict[str, dict] = {}

    for ent in spec["entities"]:
        row = int(ent["row"])
        col = int(ent["col"])
        colspan = int(ent.get("colspan", 1))
        x = left + col * col_w + gap_x / 2
        cell_y = top + row * row_h + gap_y / 2
        w = col_w * colspan - gap_x
        attrs = ent.get("attributes", [])
        header_h = 96
        attr_h = 56
        h = header_h + max(1, len(attrs)) * attr_h + 22
        h = min(h, row_h - gap_y)
        y = cell_y + max(0, (row_h - gap_y - h) / 2)
        fill, stroke = style_for(ent.get("kind", "data_store"))
        if ent.get("semantic_only"):
            fill, stroke = PALETTE["gray"], PALETTE["gray_stroke"]
        out.append(box(x, y, w, h, fill=fill, stroke=stroke, radius=14, stroke_width=3, dash="9 6" if ent.get("semantic_only") else None))
        out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{header_h:.1f}" rx="14" fill="{stroke}" opacity="0.10"/>')
        out.append(svg_text(x + 22, y + 63, ent["label"], size=48, weight=700))
        cursor = y + header_h + 43
        for attr in attrs:
            key = attr.get("key", "")
            prefix = (key + " ") if key else ""
            text = f"{prefix}{attr['name']} : {attr.get('type', '')}".strip()
            out.append(svg_text(x + 22, cursor, text, size=41, weight=700 if key else 400, fill=PALETTE["ink"]))
            cursor += attr_h
        entity_pos[ent["id"]] = {"x": x, "y": y, "w": w, "h": h}

    for rel in spec.get("relationships", []):
        a = entity_pos[rel["from"]]
        b = entity_pos[rel["to"]]
        acx, acy = a["x"] + a["w"] / 2, a["y"] + a["h"] / 2
        bcx, bcy = b["x"] + b["w"] / 2, b["y"] + b["h"] / 2
        dashed = "8 6" if rel.get("logical") else None

        dx, dy = bcx - acx, bcy - acy
        if abs(dx) >= abs(dy):
            if dx >= 0:
                start = (a["x"] + a["w"], acy)
                end = (b["x"], bcy)
            else:
                start = (a["x"], acy)
                end = (b["x"] + b["w"], bcy)
            mx = (start[0] + end[0]) / 2
            pts = [start, (mx, start[1]), (mx, end[1]), end]
        else:
            if dy >= 0:
                start = (acx, a["y"] + a["h"])
                end = (bcx, b["y"])
            else:
                start = (acx, a["y"])
                end = (bcx, b["y"] + b["h"])
            my = (start[1] + end[1]) / 2
            pts = [start, (start[0], my), (end[0], my), end]

        out.append(polyline(pts, dash=dashed, width=2))
        out.append(svg_text(start[0] + 12, start[1] - 10, rel.get("from_card", ""), size=28, weight=700, fill=PALETTE["line"]))
        out.append(svg_text(end[0] - 12, end[1] - 10, rel.get("to_card", ""), size=28, weight=700, anchor="end", fill=PALETTE["line"]))
        label = rel.get("label")
        if label and spec.get("show_relationship_labels", False):
            mx = sum(p[0] for p in pts) / len(pts)
            my = sum(p[1] for p in pts) / len(pts)
            out.append(svg_text(mx, my - 10, label, size=25, anchor="middle", fill=PALETTE["muted"], max_chars=24, line_height=28))

    add_footer_notes(out, width, height, spec.get("notes", []))
    out.append("</svg>")
    return "\n".join(out)


def render_process(spec: dict) -> str:
    width = int(spec.get("width", 2300))
    height = int(spec.get("height", 1500))
    out = svg_header(width, height, spec["title"], spec.get("subtitle"))
    stages = spec["stages"]
    cols = int(spec.get("columns", 2))
    rows = math.ceil(len(stages) / cols)
    left, right, top, bottom = 85, 85, 175, 185
    col_w = (width - left - right) / cols
    row_h = (height - top - bottom) / rows
    cards: list[dict] = []

    for i, stage in enumerate(stages):
        row = i // cols
        col = i % cols
        x = left + col * col_w + 24
        y = top + row * row_h + 20
        w = col_w - 48
        h = row_h - 40
        fill, stroke = style_for(stage["status"])
        out.append(box(x, y, w, h, fill=fill, stroke=stroke, radius=18))
        out.append(svg_text(x + 22, y + 48, f"{i+1}. {stage['title']}", size=40, weight=700, max_chars=38, line_height=43))
        badge = stage.get("evidence", stage["status"].replace("_", " ").title())
        bw = min(w - 44, max(300, len(badge) * 16))
        out.append(box(x + 22, y + 84, bw, 46, fill=PALETTE["white"], stroke=stroke, radius=9, stroke_width=2))
        out.append(svg_text(x + 22 + bw / 2, y + 116, badge, size=26, weight=700, anchor="middle", fill=stroke))
        detail_y = y + 170
        for j, t in enumerate(lines_for(stage.get("detail", ""), 48)[:3]):
            out.append(svg_text(x + 22, detail_y + j * 36, t, size=30, fill=PALETTE["muted"]))
        cards.append({"x": x, "y": y, "w": w, "h": h})

    for i in range(len(cards) - 1):
        a, b = cards[i], cards[i + 1]
        if i % cols == cols - 1:
            start = (a["x"] + a["w"] / 2, a["y"] + a["h"])
            end = (b["x"] + b["w"] / 2, b["y"])
            mid_y = (start[1] + end[1]) / 2
            pts = [start, (start[0], mid_y), (end[0], mid_y), end]
        else:
            start = (a["x"] + a["w"], a["y"] + a["h"] / 2)
            end = (b["x"], b["y"] + b["h"] / 2)
            pts = [start, end]
        out.append(polyline(pts, arrow=True, width=3))

    legend = spec.get("legend", [])
    if legend:
        x, y = 100, height - 65
        for item in legend:
            fill, stroke = style_for(item["status"])
            out.append(box(x, y - 25, 32, 24, fill=fill, stroke=stroke, radius=5, stroke_width=2))
            out.append(svg_text(x + 44, y - 4, item["label"], size=24, fill=PALETTE["muted"]))
            x += 44 + len(item["label"]) * 8 + 30
    out.append("</svg>")
    return "\n".join(out)


def render_timeline(spec: dict) -> str:
    width = int(spec.get("width", 2800))
    height = int(spec.get("height", 1450))
    out = svg_header(width, height, spec["title"], spec.get("subtitle"))
    start_day = int(spec["start_day"])
    end_day = int(spec["end_day"])
    days = list(range(start_day, end_day + 1))
    tasks = spec["tasks"]

    left_label = 650
    right = 70
    top = 190
    row_h = 100
    header_h = 82
    chart_w = width - left_label - right
    day_w = chart_w / len(days)

    out.append(box(55, top, left_label - 55, header_h, fill="#dfe7ef", stroke=PALETTE["line"], radius=0, stroke_width=2))
    out.append(svg_text(82, top + 53, "Development activity", size=40, weight=700))
    for i, day in enumerate(days):
        x = left_label + i * day_w
        out.append(box(x, top, day_w, header_h, fill="#dfe7ef", stroke=PALETTE["line"], radius=0, stroke_width=1))
        out.append(svg_text(x + day_w / 2, top + 53, str(day), size=30, weight=700, anchor="middle"))

    for idx, task in enumerate(tasks):
        y = top + header_h + idx * row_h
        out.append(box(55, y, left_label - 55, row_h, fill=PALETTE["white"], stroke=PALETTE["grid"], radius=0, stroke_width=1))
        out.append(svg_text(80, y + 43, task["label"], size=36, weight=700 if task.get("milestone") else 400, max_chars=31, line_height=38))
        for i in range(len(days)):
            x = left_label + i * day_w
            out.append(box(x, y, day_w, row_h, fill=PALETTE["white"], stroke=PALETTE["grid"], radius=0, stroke_width=1))
        s = max(start_day, int(task.get("start", start_day)))
        e = min(end_day, int(task.get("end", end_day)))
        x = left_label + (s - start_day) * day_w + 10
        w = (e - s + 1) * day_w - 20
        fill, stroke = style_for(task.get("status", "implemented"))
        dash = "10 7" if task.get("pending") else None
        out.append(box(x, y + 20, w, row_h - 40, fill=fill, stroke=stroke, radius=10, stroke_width=3, dash=dash))
        if task.get("status_label"):
            out.append(svg_text(x + w / 2, y + 60, task["status_label"], size=24, weight=700, anchor="middle", fill=stroke, max_chars=20))

    legend_y = top + header_h + len(tasks) * row_h + 45
    x = 80
    for item in spec.get("legend", []):
        fill, stroke = style_for(item["status"])
        out.append(box(x, legend_y - 24, 34, 24, fill=fill, stroke=stroke, radius=5, stroke_width=2, dash="8 6" if item.get("pending") else None))
        out.append(svg_text(x + 46, legend_y - 4, item["label"], size=24, fill=PALETTE["muted"]))
        x += 46 + len(item["label"]) * 9 + 35

    add_footer_notes(out, width, height, spec.get("notes", []))
    out.append("</svg>")
    return "\n".join(out)


def render_sequence(spec: dict) -> str:
    width = int(spec.get("width", 2600))
    height = int(spec.get("height", 1600))
    out = svg_header(width, height, spec["title"], spec.get("subtitle"))
    actors = spec["actors"]
    messages = spec["messages"]
    actor_w = 390
    actor_h = 96
    left = actor_w / 2 + 45
    right = actor_w / 2 + 45
    top, bottom = 170, 155
    usable = width - left - right
    step_x = usable / max(1, len(actors) - 1)
    actor_pos: dict[str, float] = {}
    life_top = top + actor_h
    life_bottom = height - bottom

    for i, actor in enumerate(actors):
        cx = left + i * step_x
        actor_pos[actor["id"]] = cx
        fill, stroke = style_for(actor.get("kind", "component"))
        out.append(box(cx - actor_w / 2, top, actor_w, actor_h, fill=fill, stroke=stroke, radius=15))
        out.append(svg_text(cx, top + 52, actor["label"], size=32, weight=700, anchor="middle", max_chars=21, line_height=34))
        out.append(line(cx, life_top, cx, life_bottom, stroke=PALETTE["gray_stroke"], width=2, dash="10 8"))

    available_h = life_bottom - life_top - 45
    msg_gap = available_h / max(1, len(messages))
    for i, msg in enumerate(messages):
        y = life_top + 48 + i * msg_gap
        x1 = actor_pos[msg["from"]]
        x2 = actor_pos[msg["to"]]
        dash = "8 6" if msg.get("dashed") else None
        label = f"{i+1}. {msg['label']}"
        if x1 == x2:
            loop_w = 190
            loop_h = 40
            pts = [
                (x1, y),
                (x1 + loop_w, y),
                (x1 + loop_w, y + loop_h),
                (x1, y + loop_h),
            ]
            out.append(polyline(pts, arrow=True, dash=dash, width=3))
            mid = x1 + loop_w / 2
            out.append(svg_text(mid, y - 13, label, size=30, weight=700, anchor="middle", max_chars=30, line_height=32))
            note_y = y + loop_h + 26
        else:
            out.append(line(x1, y, x2, y, width=3, arrow=True, dash=dash))
            mid = (x1 + x2) / 2
            out.append(svg_text(mid, y - 13, label, size=30, weight=700, anchor="middle", max_chars=30, line_height=32))
            note_y = y + 26
        if msg.get("note") and spec.get("show_message_notes", False):
            out.append(svg_text(mid, note_y, msg["note"], size=22, anchor="middle", fill=PALETTE["muted"], max_chars=42, line_height=24))

    if spec.get("acceptance_status"):
        fill, stroke = style_for(spec["acceptance_status"]["status"])
        bw = 740
        x = (width - bw) / 2
        y = height - 95
        out.append(box(x, y, bw, 48, fill=fill, stroke=stroke, radius=12))
        out.append(svg_text(width / 2, y + 33, spec["acceptance_status"]["label"], size=29, weight=700, anchor="middle", fill=stroke))
    out.append("</svg>")
    return "\n".join(out)


RENDERERS = {
    "flow": render_flow,
    "erd": render_erd,
    "process": render_process,
    "timeline": render_timeline,
    "sequence": render_sequence,
}


def validate_spec(spec: dict, path: Path) -> None:
    required = ("id", "type", "title", "output")
    missing = [key for key in required if not spec.get(key)]
    if missing:
        raise ValueError(f"{path}: missing required keys: {', '.join(missing)}")
    if spec["type"] not in RENDERERS:
        raise ValueError(f"{path}: unsupported figure type {spec['type']!r}")


def generate_one(path: Path, check_only: bool = False) -> Path:
    spec = json.loads(path.read_text(encoding="utf-8"))
    validate_spec(spec, path)
    renderer = RENDERERS[spec["type"]]
    svg = renderer(spec)
    ET.fromstring(svg)
    output = ROOT / spec["output"]
    if not check_only:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(svg, encoding="utf-8", newline="\n")
    return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "specs",
        nargs="*",
        help="JSON specs. Defaults to artifacts/figures/specs/*.json",
    )
    parser.add_argument("--check", action="store_true", help="Validate specs/rendered XML without writing SVGs")
    args = parser.parse_args()

    if args.specs:
        paths = [ROOT / p for p in args.specs]
    else:
        paths = sorted((ROOT / "artifacts" / "figures" / "specs").glob("*.json"))

    if not paths:
        print("No figure specifications found.", file=sys.stderr)
        return 2

    try:
        for path in paths:
            output = generate_one(path, check_only=args.check)
            action = "checked" if args.check else "generated"
            print(f"{action}: {path.relative_to(ROOT)} -> {output.relative_to(ROOT)}")
    except Exception as exc:
        print(f"figure generation failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
