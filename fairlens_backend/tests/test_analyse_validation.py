import pytest

from app.modules.analyse.analyse_service import _validate_dataset_input
from app.schemas.analyse_schema import AnalyseRequest


def test_validation_missing_columns():
    req = AnalyseRequest(
        prompt="p",
        ai_response="r",
        dataset=[{"a": 1}],
        target_column="target",
        prediction_column="pred",
        protected_attribute="group",
    )
    with pytest.raises(ValueError):
        _validate_dataset_input(req)


def test_validation_empty_groups():
    req = AnalyseRequest(
        prompt="p",
        ai_response="r",
        dataset=[
            {"target": 1, "pred": 1, "group": "A"},
            {"target": 0, "pred": 0, "group": "A"},
        ],
        target_column="target",
        prediction_column="pred",
        protected_attribute="group",
    )
    with pytest.raises(ValueError):
        _validate_dataset_input(req)
