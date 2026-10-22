from collections import deque

import pytest

from app.domain.statuses import STATUS_INFO, TRANSITIONS, Actor, Status, can_transition, targets, to_mermaid


def test_every_status_is_described():
    assert set(STATUS_INFO) == set(Status)


def test_terminal_statuses_have_no_exits_and_others_do():
    for status, info in STATUS_INFO.items():
        if info.terminal:
            assert targets(status) == [], status
        else:
            assert targets(status), status


def test_every_status_is_reachable_from_draft():
    seen = {Status.DRAFT}
    queue = deque([Status.DRAFT])
    while queue:
        for nxt in targets(queue.popleft()):
            if nxt not in seen:
                seen.add(nxt)
                queue.append(nxt)
    assert seen == set(Status)


@pytest.mark.parametrize(
    ("src", "dst", "actor", "allowed"),
    [
        (Status.DRAFT, Status.SUBMITTED, Actor.CLIENT, True),
        (Status.DRAFT, Status.SUBMITTED, Actor.SYSTEM, False),
        (Status.SCORING, Status.APPROVED, Actor.SYSTEM, True),
        (Status.SCORING, Status.APPROVED, Actor.CLIENT, False),
        (Status.SCORING, Status.APPROVED, Actor.ANALYST, False),
        (Status.MANUAL_REVIEW, Status.APPROVED, Actor.ANALYST, True),
        (Status.MANUAL_REVIEW, Status.APPROVED, Actor.SYSTEM, False),
        (Status.COUNTER_OFFER, Status.SIGNING, Actor.CLIENT, True),
        (Status.SIGNING, Status.ISSUED, Actor.SYSTEM, True),
        (Status.SIGNING, Status.ISSUED, Actor.CLIENT, False),
        (Status.DRAFT, Status.APPROVED, Actor.SYSTEM, False),
        (Status.REJECTED, Status.APPROVED, Actor.ANALYST, False),
    ],
)
def test_transition_rules(src, dst, actor, allowed):
    assert can_transition(src, dst, actor) is allowed


def test_client_can_cancel_any_unfinished_application():
    for status, info in STATUS_INFO.items():
        assert can_transition(status, Status.CANCELLED, Actor.CLIENT) is (not info.terminal), status


def test_mermaid_diagram_lists_every_transition():
    diagram = to_mermaid()
    for src, dst in TRANSITIONS:
        assert f"{src.value} --> {dst.value}" in diagram
