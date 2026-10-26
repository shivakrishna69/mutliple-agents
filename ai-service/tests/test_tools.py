"""Worker tools and the tool-call executor, including the server-injected customer scope."""

import json

import pytest

from app.nodes.worker_tools import ToolExecutionError, check_invoice_status, query_system_logs
from app.nodes.workers import execute_tool_call

TOOLS_BY_NAME = {check_invoice_status.name: check_invoice_status, query_system_logs.name: query_system_logs}


def test_query_system_logs_normalises_codes_and_reports_known_errors():
    result = json.loads(query_system_logs.invoke({"error_code": " err-502 gateway "}))
    assert result["found"] is True
    assert result["error_code"] == "ERR_502_GATEWAY"
    assert result["data_source"] == "simulated"


def test_query_system_logs_rejects_malformed_and_unknown_codes():
    assert json.loads(query_system_logs.invoke({"error_code": "drop table"}))["found"] is False
    unknown = json.loads(query_system_logs.invoke({"error_code": "ERR_999_UNKNOWN"}))
    assert unknown["found"] is False
    assert "ERR_502_GATEWAY" in unknown["known_error_codes"]


def test_invoice_status_is_deterministic_per_customer():
    first = check_invoice_status.invoke({"user_id": "customer-a"})
    assert check_invoice_status.invoke({"user_id": "customer-a"}) == first
    assert len(json.loads(first)["recent_invoices"]) == 3


def test_the_model_never_sees_the_customer_id_argument():
    assert "user_id" not in check_invoice_status.tool_call_schema.model_json_schema().get("properties", {})


async def test_customer_id_comes_from_the_server_even_if_the_model_supplies_another(caplog):
    tool_call = {"name": "check_invoice_status", "args": {"user_id": "someone-else"}, "id": "call-1"}
    tool_message, log_entry = await execute_tool_call(
        tool_call, TOOLS_BY_NAME, {"customer_id": "customer-a"}, "billing_agent"
    )
    assert tool_message.status == "success"
    assert tool_message.content == check_invoice_status.invoke({"user_id": "customer-a"})
    assert tool_message.content != check_invoice_status.invoke({"user_id": "someone-else"})
    # The attempt is recorded as a warning; neither customer id is copied into the audit trail.
    assert "Discarded model-supplied value" in caplog.text
    assert "someone-else" not in log_entry
    assert "customer-a" not in log_entry


async def test_unknown_tools_and_bad_arguments_become_error_messages_for_the_model():
    unknown_message, _ = await execute_tool_call(
        {"name": "delete_account", "args": {}, "id": "call-2"}, TOOLS_BY_NAME, {}, "tech_agent"
    )
    assert unknown_message.status == "error"

    bad_arguments_message, _ = await execute_tool_call(
        {"name": "query_system_logs", "args": "ERR_502_GATEWAY", "id": "call-3"}, TOOLS_BY_NAME, {}, "tech_agent"
    )
    assert bad_arguments_message.status == "error"


async def test_invoice_lookup_without_a_customer_fails_the_turn():
    with pytest.raises(ToolExecutionError):
        await execute_tool_call(
            {"name": "check_invoice_status", "args": {}, "id": "call-4"}, TOOLS_BY_NAME, {}, "billing_agent"
        )
