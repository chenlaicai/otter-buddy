"""Generate a soft, avatar-first otter with sand3d 1.6.3 (Blender 4.5).

Environment: Python 3.11, bpy 4.5, sand3d 1.6.3. No textures or external assets.
The first prototype's protruding eyes, split cheek discs and glossy ceramic
read as uncanny. This revision uses a connected silhouette, shallow facial
features and matte plastic. Distances below are millimetres; export is Y-up.
"""
from pathlib import Path

import bpy
import sand3d as s3d

OUT = Path(__file__).resolve().parents[2] / "web/public/avatars/otter-3d.glb"


def pebble(name, size, position, color, kind="plastic", roughness=0.86):
    """An ellipsoid with radii ``size``, centred exactly at ``position``.

    sand3d's sphere takes a diameter and puts its object origin at the bottom.
    Build a radius-one sphere, scale the vertices, then compensate the bottom
    origin by the vertical radius; a constant offset detaches unequal parts.
    """
    part = s3d.sphere(name, 2)
    s3d.scale(part, size)
    # The stock revolved sphere is deliberately low-poly. One applied
    # subdivision pass keeps the silhouette soft without a runtime dependency.
    bpy.context.view_layer.objects.active = part
    subdiv = part.modifiers.new("Soft silhouette", "SUBSURF")
    subdiv.levels = 1
    bpy.ops.object.modifier_apply(modifier=subdiv.name)
    s3d.at(part, x=position[0], y=position[1], z=position[2] - size[2])
    s3d.material(part, kind, color=color, roughness=roughness)
    return part


def smile(name, side):
    line = s3d.wire(
        name,
        [(0, 0, 0), (side * 0.10, 0, -0.035), (side * 0.19, 0, 0.035)],
        0.022,
        fillet=0.04,
    )
    s3d.at(line, x=0, y=-1.225, z=-0.035)
    s3d.material(line, "plastic", color="#394146", roughness=0.85)
    return line


def build_otter():
    s3d.units("mm")
    fur = "#718996"
    fur_dark = "#607a87"
    cream = "#ede8dc"
    ink = "#26343b"
    eye_ink = "#1d2b31"
    scarf = "#9f3f3c"

    # A small connected body grounds the large head; no floating bust or paws.
    body = s3d.assembly(
        "Otter",
        pebble("body", (1.28, 0.86, 0.82), (0, 0.08, -1.13), fur),
        pebble("foot_l", (0.46, 0.56, 0.24), (-0.52, -0.30, -1.78), fur_dark),
        pebble("foot_r", (0.46, 0.56, 0.24), (0.52, -0.30, -1.78), fur_dark),
        pebble("tail", (0.50, 0.94, 0.25), (0, 0.88, -1.52), fur_dark),
    )
    head_parts = [
        pebble("head", (1.75, 1.08, 1.32), (0, 0, 0.35), fur),
    ]
    for side, label in [(-1, "l"), (1, "r")]:
        head_parts.append(
            pebble(f"ear_{label}", (0.37, 0.27, 0.38), (side * 1.15, 0.03, 1.34), fur_dark),
        )
        eye = s3d.group(
            f"eye_{label}",
            pebble(f"eye_dark_{label}", (0.12, 0.075, 0.15), (side * 0.56, -0.985, 0.67), eye_ink, roughness=0.30),
            pebble(f"eye_glint_{label}", (0.028, 0.012, 0.032), (side * 0.56 - 0.025, -1.06, 0.72), "#fff8e9", roughness=0.65),
        )
        # Centre the blink pivot on the actual child geometry. The children
        # become local offsets; assigning only a nominal pivot tears them away.
        eye.location = (side * 0.56, -0.985, 0.67)
        for child in eye.children:
            child.location -= eye.location
        head_parts.append(eye)

    head_parts.extend([
        # One shallow muzzle, not two protruding white cheek spheres.
        pebble("muzzle", (0.72, 0.22, 0.38), (0, -1.00, 0.04), cream),
        pebble("nose", (0.17, 0.075, 0.10), (0, -1.19, 0.22), ink, roughness=0.82),
        smile("smile_l", -1),
        smile("smile_r", 1),
    ])
    head = s3d.assembly("HeadPivot", *head_parts)
    # joint() records the pivot without moving the assembled geometry. Keep
    # every face part in this one frame so nodding cannot disassemble it.
    s3d.joint("nod", head, on=s3d.local(body, z=-0.72), kind="continuous", axis="+X")

    s3d.attach(
        body,
        "scarf",
        pebble("scarf_collar", (1.16, 0.80, 0.16), (0, -0.01, -0.78), scarf, roughness=0.9),
        pebble("scarf_knot", (0.14, 0.09, 0.14), (0.43, -0.80, -0.91), "#873432", roughness=0.9),
        s3d.at(pebble("scarf_tail", (0.14, 0.055, 0.34), (0.47, -0.82, -1.20), scarf, roughness=0.9), ry=10),
    )
    s3d.attach(
        body,
        "paws",
        pebble("paw_l", (0.28, 0.27, 0.36), (-1.00, -0.43, -1.37), fur_dark),
        pebble("paw_r", (0.28, 0.27, 0.36), (1.00, -0.43, -1.37), fur_dark),
    )
    return body


if __name__ == "__main__":
    s3d.empty_scene()
    avatar = build_otter()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    s3d.export(avatar, OUT)
    print(f"Generated {OUT} with sand3d {s3d.__version__} ({s3d.fingerprint()})")
    print("Nodes:", ", ".join(ob.name for ob in bpy.context.scene.objects))
