import base64
import io
import json
import sys
from pathlib import Path

import pytest

pytest.importorskip("cv2")
from PIL import Image
import match_reference_gear


def test_gear_reference_requires_matching_face_features(monkeypatch, capsys):
    root = Path(__file__).resolve().parents[2]
    with Image.open(root / "backend/references/spur-86.jpg") as original:
        variant = original.rotate(28, expand=True).resize((470, 470))
        jpeg = io.BytesIO()
        variant.save(jpeg, format="JPEG", quality=68)
    unrelated = (root / "vision-engine/tests/fixtures/spur_gear.png").read_bytes()
    for views, expected in [([unrelated], ""), ([unrelated, jpeg.getvalue()], "match")]:
        payload = [base64.b64encode(view).decode("ascii") for view in views]
        monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))
        match_reference_gear.main()
        assert capsys.readouterr().out.strip() == expected
