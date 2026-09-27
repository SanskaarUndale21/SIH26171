from fastapi.testclient import TestClient

from app import main, planner
from app.models import ActionTarget, NextActionResponse
from app.safety import enforce_redaction_safety

client = TestClient(main.app)


def test_health_reports_planner():
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert "planner_model" in body and "open_weights" in body


def test_task_bridge_round_trip():
    assert client.get("/api/tasks/claim").status_code == 204

    task = client.post("/api/tasks", json={"goal": "fill the form with [EMAIL_1]"}).json()
    assert task["status"] == "pending"

    claimed = client.get("/api/tasks/claim").json()
    assert claimed["id"] == task["id"]
    assert client.get("/api/tasks/claim").status_code == 204  # claimed once only

    client.post(f"/api/tasks/{task['id']}/events", json={"kind": "step", "text": "Step 1: click #next"})
    view = client.get(f"/api/tasks/{task['id']}").json()
    assert view["status"] == "running" and view["next"] == 1

    client.post(f"/api/tasks/{task['id']}/events", json={"kind": "done", "text": "Done.", "data": {"reason": "completed"}})
    later = client.get(f"/api/tasks/{task['id']}", params={"after": 1}).json()
    assert later["status"] == "done"
    assert [e["kind"] for e in later["events"]] == ["done"]


def test_unknown_task_404():
    assert client.get("/api/tasks/nope").status_code == 404
    assert client.post("/api/tasks/nope/events", json={"kind": "step", "text": "x"}).status_code == 404


def test_jarvis_proxy_forces_server_model(monkeypatch):
    seen = {}

    class FakeCompletion:
        def model_dump(self, exclude_none=True):
            return {"choices": [{"message": {"role": "assistant", "content": "hi"}}]}

    class FakeClient:
        class chat:
            class completions:
                @staticmethod
                def create(**kwargs):
                    seen.update(kwargs)
                    return FakeCompletion()

    monkeypatch.setattr(planner, "_get_client", lambda: FakeClient)
    monkeypatch.setattr(planner, "_get_jarvis_client", lambda: FakeClient)
    res = client.post(
        "/api/jarvis/chat/completions",
        json={"model": "ignored", "messages": [{"role": "user", "content": "hello"}], "stream": True},
    )
    assert res.status_code == 200
    assert res.json()["choices"][0]["message"]["content"] == "hi"
    assert seen["model"] == planner.jarvis_model()
    assert "stream" not in seen

    image_msg = {"role": "user", "content": [{"type": "text", "text": "what is on screen"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}}]}
    client.post("/api/jarvis/chat/completions", json={"messages": [image_msg]})
    assert seen["model"] == planner.planner_model()


def test_placeholder_is_never_typed():
    action = NextActionResponse(action="type", target=ActionTarget(selector="#email"), value="[EMAIL_1]")
    safe = enforce_redaction_safety(action, [])
    assert safe.action == "ask_user" and safe.value == "[EMAIL_1]"


def test_closed_model_detection(monkeypatch):
    monkeypatch.setenv("PLANNER_MODEL", "gpt-4o-mini")
    monkeypatch.delenv("PLANNER_BASE_URL", raising=False)
    assert planner.planner_info()["open_weights"] is False
    monkeypatch.setenv("PLANNER_MODEL", planner.DEFAULT_PLANNER_MODEL)
    info = planner.planner_info()
    assert info["open_weights"] is True and info["endpoint"] == planner.DEFAULT_BASE_URL


def test_action_synonyms_are_normalized():
    assert planner.normalize_action("select") == "type"
    assert planner.normalize_action("Go To") == "navigate"
    assert planner.normalize_action("done") == "none"
    try:
        planner.normalize_action("teleport")
    except ValueError:
        pass
    else:
        raise AssertionError("unknown action must not be accepted")


def test_click_with_value_on_select_becomes_choose():
    from app.models import InteractiveElementSummary, StructuredSummary
    summary = StructuredSummary(fields=1, submit_button=None, detected_via="dom", interactive_elements=[
        InteractiveElementSummary(selector="#course", tag="select", label="course", isSubmit=False, options=["B.Tech", "B.Sc"])])
    click = NextActionResponse(action="click", target=ActionTarget(selector="#course"), value="B.Sc")
    assert planner.fix_select_click(click, summary).action == "type"
    wrong = NextActionResponse(action="click", target=ActionTarget(selector="#course"), value="MBA")
    assert planner.fix_select_click(wrong, summary).action == "click"
