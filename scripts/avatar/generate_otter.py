"""Generate the clay-style Otter Buddy avatar with sand3d (Blender 4.5).

Run with a Python environment containing bpy and sand3d==1.6.3:
    python scripts/avatar/generate_otter.py
The front end consumes named nodes in the resulting GLB; it does not rebuild
or texture over the model. Distances below are millimetres.
"""
from pathlib import Path

import bpy
import sand3d as s3d
from mathutils import Vector

OUT = Path(__file__).resolve().parents[2] / "web/public/avatars/otter-3d.glb"


def pebble(name, size, position, color, kind="ceramic", roughness=0.48):
    """A scaled sphere; sand3d makes the editable, closed geometry."""
    # s3d.sphere is a revolved primitive with enough meridians for a smooth
    # close-up; scale its vertices rather than relying on object transforms.
    part = s3d.sphere(name, 1)
    s3d.scale(part, size)
    s3d.at(part, x=position[0], y=position[1], z=position[2] - 0.5)
    s3d.material(part, kind, color=color, roughness=roughness)
    return part


def build_otter():
    s3d.units("mm")
    fur = "#5b7484"
    fur_dark = "#46606e"
    cream = "#ede8dc"
    ink = "#283238"
    scarf = "#c25450"

    body = s3d.assembly(
        "Otter",
        pebble("body", (1.80, 1.20, 1.15), (0, 0.05, -0.73), fur),
        pebble("belly", (1.13, 0.32, 0.69), (0, -0.60, -0.66), cream),
        pebble("foot_l", (0.60, 0.77, 0.28), (-0.62, -0.35, -1.19), fur_dark),
        pebble("foot_r", (0.60, 0.77, 0.28), (0.62, -0.35, -1.19), fur_dark),
        pebble("tail", (0.66, 1.32, 0.31), (0, 1.14, -1.12), fur_dark),
    )
    head_parts = [
        pebble("head", (1.97, 1.30, 1.48), (0, -0.06, 0.45), fur),
    ]
    for side, label in [(-1, "l"), (1, "r")]:
        head_parts.extend([
            pebble(f"ear_{label}", (0.47, 0.34, 0.48), (side * 0.94, 0.01, 1.15), fur_dark),
            pebble(f"inner_ear_{label}", (0.26, 0.15, 0.28), (side * 0.97, -0.25, 1.16), "#c89a8e"),
            pebble(f"cheek_{label}", (0.64, 0.30, 0.40), (side * 0.35, -0.73, 0.18), cream),
            pebble(f"brow_{label}", (0.33, 0.06, 0.055), (side * 0.62, -0.72, 1.17), fur_dark),
        ])
        eye = s3d.group(
            f"eye_{label}",
            pebble(f"eye_dark_{label}", (0.205, 0.115, 0.255), (side * 0.59, -0.82, 0.95), ink, roughness=0.25),
            pebble(f"eye_glint_{label}", (0.052, 0.035, 0.063), (side * 0.59 - 0.032, -0.916, 1.01), "#fffaf1", roughness=0.15),
        )
        # Named, separate eyes allow the renderer to close them without
        # changing the source mesh or relying on facial morph targets.
        eye.location = (side * 0.59, -0.82, 0.95)
        for child in eye.children:
            child.location -= eye.location
        head_parts.append(eye)


    head_parts.extend([
        pebble("nose", (0.27, 0.18, 0.16), (0, -1.01, 0.31), ink, roughness=0.32),

    ])
    # Subtle, sculptural smile: a curved tube rather than a painted texture.
    # A baked head pivot keeps every facial feature together when nodding.

    for side, label in [(-1, "l"), (1, "r")]:
        smile = s3d.wire(
            f"smile_{label}",
            [(0, 0, 0), (side * 0.12, 0, -0.035), (side * 0.25, 0, 0.025)],
            0.05,
            fillet=0.06,
        )
        s3d.at(smile, x=0, y=-1.005, z=0.09)
        s3d.material(smile, "ceramic", color=ink, roughness=0.4)
        head_parts.append(smile)
    head = s3d.assembly("HeadPivot", *head_parts)
    s3d.joint("nod", head, on=s3d.local(body, z=-0.20), kind="continuous", axis="+X")
    # A scarf knot and two soft, asymmetric tails keep the silhouette from
    # becoming a generic snowman.
    s3d.attach(head, "scarf",
        pebble("scarf_collar", (1.33, 0.93, 0.28), (0, -0.05, -0.47), scarf, kind="fabric", roughness=0.8),
        pebble("scarf_knot", (0.30, 0.22, 0.34), (0.59, -0.85, -0.49), "#a8413e", kind="fabric", roughness=0.8),
        s3d.at(pebble("scarf_tail_long", (0.26, 0.13, 0.59), (0.69, -0.88, -0.88), scarf, kind="fabric", roughness=0.8), ry=18),
        s3d.at(pebble("scarf_tail_short", (0.22, 0.12, 0.38), (0.32, -0.92, -0.73), "#a8413e", kind="fabric", roughness=0.8), ry=-22),
    )
    s3d.attach(body, "paws",
        pebble("paw_l", (0.34, 0.32, 0.58), (-0.88, -0.42, -0.63), fur_dark),
        pebble("paw_r", (0.34, 0.32, 0.58), (0.88, -0.42, -0.63), fur_dark),
    )
    return body


if __name__ == "__main__":
    s3d.empty_scene()
    avatar = build_otter()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    s3d.export(avatar, OUT)
    print(f"Generated {OUT} with sand3d {s3d.__version__} ({s3d.fingerprint()})")
    print("Nodes:", ", ".join(ob.name for ob in bpy.context.scene.objects))
