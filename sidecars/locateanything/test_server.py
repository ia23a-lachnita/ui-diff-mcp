import os
import platform
import sys
import unittest
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

from sidecars.locateanything.server import (
    _apply_worker_runtime_config,
    _create_worker,
    _locateanything_max_new_tokens,
    _locateanything_top_k,
    _resolve_backend,
    AppState,
)


class _CppWorkerStub:
    """Stub for CppLocateAnythingWorker — no processor.image_processor."""

    pass


class _IdentifiableCppWorkerStub(_CppWorkerStub):
    """Stub that is explicitly identifiable as a C++ worker via type tag."""

    _backend = "cpp"


class _OfficialWorkerStub:
    """Stub for official LocateAnythingWorker with processor.image_processor."""

    def __init__(self):
        self.processor = MagicMock()
        self.processor.image_processor.in_token_limit = 25600


class _MalformedOfficialWorkerStub:
    """Official worker stub missing processor — should trigger config error."""

    pass


# ---------------------------------------------------------------------------
# TopK tests
# ---------------------------------------------------------------------------

class TopKTests(unittest.TestCase):
    def test_unset_returns_zero(self) -> None:
        self.assertEqual(_locateanything_top_k({}), 0)

    def test_explicit_positive_value_passes(self) -> None:
        self.assertEqual(_locateanything_top_k({"LOCATEANYTHING_TOP_K": "5"}), 5)
        self.assertEqual(_locateanything_top_k({"LOCATEANYTHING_TOP_K": "1"}), 1)
        self.assertEqual(_locateanything_top_k({"LOCATEANYTHING_TOP_K": "200"}), 200)

    def test_explicit_zero_fails(self) -> None:
        with self.assertRaises(ValueError):
            _locateanything_top_k({"LOCATEANYTHING_TOP_K": "0"})

    def test_explicit_negative_fails(self) -> None:
        with self.assertRaises(ValueError):
            _locateanything_top_k({"LOCATEANYTHING_TOP_K": "-1"})

    def test_non_integer_fails(self) -> None:
        with self.assertRaises(ValueError):
            _locateanything_top_k({"LOCATEANYTHING_TOP_K": "abc"})


# ---------------------------------------------------------------------------
# MaxNewTokens tests
# ---------------------------------------------------------------------------

class MaxNewTokensTests(unittest.TestCase):
    def test_default_is_512(self) -> None:
        self.assertEqual(_locateanything_max_new_tokens({}), 512)

    def test_explicit_valid_value(self) -> None:
        self.assertEqual(_locateanything_max_new_tokens({"LOCATEANYTHING_MAX_NEW_TOKENS": "256"}), 256)

    def test_minimum_boundary(self) -> None:
        self.assertEqual(_locateanything_max_new_tokens({"LOCATEANYTHING_MAX_NEW_TOKENS": "1"}), 1)

    def test_maximum_boundary(self) -> None:
        self.assertEqual(_locateanything_max_new_tokens({"LOCATEANYTHING_MAX_NEW_TOKENS": "2048"}), 2048)

    def test_zero_fails(self) -> None:
        with self.assertRaises(ValueError):
            _locateanything_max_new_tokens({"LOCATEANYTHING_MAX_NEW_TOKENS": "0"})

    def test_over_maximum_fails(self) -> None:
        with self.assertRaises(ValueError):
            _locateanything_max_new_tokens({"LOCATEANYTHING_MAX_NEW_TOKENS": "2049"})

    def test_non_integer_fails(self) -> None:
        with self.assertRaises(ValueError):
            _locateanything_max_new_tokens({"LOCATEANYTHING_MAX_NEW_TOKENS": "abc"})


# ---------------------------------------------------------------------------
# Backend selection tests
# ---------------------------------------------------------------------------

class BackendSelectionTests(unittest.TestCase):
    def test_explicit_official(self) -> None:
        self.assertEqual(_resolve_backend({"LOCATEANYTHING_BACKEND": "official"}), "official")

    def test_explicit_cpp(self) -> None:
        self.assertEqual(_resolve_backend({"LOCATEANYTHING_BACKEND": "cpp"}), "cpp")

    def test_arm_auto_selects_cpp(self) -> None:
        with patch("sidecars.locateanything.server.platform.machine", return_value="aarch64"):
            self.assertEqual(_resolve_backend({}), "cpp")

    def test_arm64_auto_selects_cpp(self) -> None:
        with patch("sidecars.locateanything.server.platform.machine", return_value="arm64"):
            self.assertEqual(_resolve_backend({}), "cpp")

    def test_non_arm_auto_selects_official(self) -> None:
        with patch("sidecars.locateanything.server.platform.machine", return_value="x86_64"):
            self.assertEqual(_resolve_backend({}), "official")

    def test_invalid_explicit_override_fails(self) -> None:
        with self.assertRaises(ValueError):
            _resolve_backend({"LOCATEANYTHING_BACKEND": "invalid"})

    def test_skip_value_rejected_by_backend(self) -> None:
        with self.assertRaises(ValueError):
            _resolve_backend({"LOCATEANYTHING_BACKEND": "skip"})

    def test_none_value_rejected_by_backend(self) -> None:
        with self.assertRaises(ValueError):
            _resolve_backend({"LOCATEANYTHING_BACKEND": "none"})

    def test_disabled_value_rejected_by_backend(self) -> None:
        with self.assertRaises(ValueError):
            _resolve_backend({"LOCATEANYTHING_BACKEND": "disabled"})

    def test_whitespace_is_stripped(self) -> None:
        self.assertEqual(_resolve_backend({"LOCATEANYTHING_BACKEND": "  official  "}), "official")

    def test_uppercase_is_lowered(self) -> None:
        self.assertEqual(_resolve_backend({"LOCATEANYTHING_BACKEND": "CPP"}), "cpp")


# ---------------------------------------------------------------------------
# Runtime config tests
# ---------------------------------------------------------------------------

class RuntimeConfigTests(unittest.TestCase):
    def test_applies_to_official_worker(self) -> None:
        worker = _OfficialWorkerStub()
        _apply_worker_runtime_config(worker, {"LOCATEANYTHING_IN_TOKEN_LIMIT": "1024"})
        self.assertEqual(worker.processor.image_processor.in_token_limit, 1024)

    def test_bypasses_pytorch_for_cpp_worker(self) -> None:
        worker = _IdentifiableCppWorkerStub()
        _apply_worker_runtime_config(worker, {"LOCATEANYTHING_IN_TOKEN_LIMIT": "1024"})

    def test_rejects_invalid_token_limit(self) -> None:
        worker = _OfficialWorkerStub()
        with self.assertRaises(ValueError):
            _apply_worker_runtime_config(worker, {"LOCATEANYTHING_IN_TOKEN_LIMIT": "0"})

    def test_rejects_non_integer_token_limit(self) -> None:
        worker = _OfficialWorkerStub()
        with self.assertRaises(ValueError):
            _apply_worker_runtime_config(worker, {"LOCATEANYTHING_IN_TOKEN_LIMIT": "abc"})

    def test_malformed_official_worker_raises_not_bypasses(self) -> None:
        worker = _MalformedOfficialWorkerStub()
        with self.assertRaises(AttributeError):
            _apply_worker_runtime_config(worker, {"LOCATEANYTHING_IN_TOKEN_LIMIT": "1024"})

    def test_noop_when_env_unset(self) -> None:
        worker = _OfficialWorkerStub()
        _apply_worker_runtime_config(worker, {})
        self.assertEqual(worker.processor.image_processor.in_token_limit, 25600)

    def test_rejects_below_minimum_token_limit(self) -> None:
        worker = _OfficialWorkerStub()
        with self.assertRaises(ValueError):
            _apply_worker_runtime_config(worker, {"LOCATEANYTHING_IN_TOKEN_LIMIT": "63"})

    def test_accepts_minimum_token_limit(self) -> None:
        worker = _OfficialWorkerStub()
        _apply_worker_runtime_config(worker, {"LOCATEANYTHING_IN_TOKEN_LIMIT": "64"})
        self.assertEqual(worker.processor.image_processor.in_token_limit, 64)

    def test_rejects_above_maximum_token_limit(self) -> None:
        worker = _OfficialWorkerStub()
        with self.assertRaises(ValueError):
            _apply_worker_runtime_config(worker, {"LOCATEANYTHING_IN_TOKEN_LIMIT": "25601"})

    def test_accepts_maximum_token_limit(self) -> None:
        worker = _OfficialWorkerStub()
        _apply_worker_runtime_config(worker, {"LOCATEANYTHING_IN_TOKEN_LIMIT": "25600"})
        self.assertEqual(worker.processor.image_processor.in_token_limit, 25600)


# ---------------------------------------------------------------------------
# Create worker tests (future-proof via sys.modules patching)
# ---------------------------------------------------------------------------

class CreateWorkerTests(unittest.TestCase):
    def test_cpp_import_failure_includes_backend_name(self) -> None:
        with (
            patch.dict(sys.modules, {"sidecars.locateanything.cpp_worker": None}),
            self.assertRaises(ImportError) as ctx,
        ):
            _create_worker("cpp")
        self.assertIn("cpp", str(ctx.exception))
        self.assertIn("sidecars.locateanything.cpp_worker", str(ctx.exception))

    def test_cpp_path_does_not_mutate_sys_path(self) -> None:
        original_path = list(sys.path)
        with (
            patch.dict(sys.modules, {"sidecars.locateanything.cpp_worker": None}),
            self.assertRaises(ImportError),
        ):
            _create_worker("cpp")
        self.assertEqual(sys.path, original_path)

    def test_official_import_failure_includes_backend_name(self) -> None:
        with (
            patch.dict(sys.modules, {"torch": None, "locateanything_worker": None}),
            self.assertRaises(ImportError) as ctx,
        ):
            _create_worker("official")
        self.assertIn("official", str(ctx.exception))

    def test_cpp_worker_receives_backend_argument(self) -> None:
        stub = _IdentifiableCppWorkerStub()
        with (
            patch("sidecars.locateanything.server._is_cpp_worker", return_value=True),
            patch.dict(sys.modules, {"sidecars.locateanything.cpp_worker": MagicMock(CppLocateAnythingWorker=MagicMock(return_value=stub))}),
        ):
            worker = _create_worker("cpp")
        self.assertIs(worker, stub)
        self.assertEqual(worker._backend, "cpp")

    def test_official_worker_receives_backend_argument(self) -> None:
        stub = _OfficialWorkerStub()
        stub._backend = "official"
        fake_torch = MagicMock()
        fake_torch.bfloat16 = "bfloat16"
        fake_worker_mod = MagicMock()
        fake_worker_mod.LocateAnythingWorker.return_value = stub
        mods = {
            "torch": fake_torch,
            "locateanything_worker": fake_worker_mod,
        }
        with patch.dict(sys.modules, mods, clear=False):
            worker = _create_worker("official")
        self.assertEqual(worker._backend, "official")


# ---------------------------------------------------------------------------
# Lifecycle tests — IsolatedAsyncioTestCase with real async with lifespan
# ---------------------------------------------------------------------------

class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    def _swap_state(self, new_state: AppState):
        """Return a context manager that swaps srv.state and restores on exit."""
        from sidecars.locateanything import server as srv
        original = srv.state
        srv.state = new_state
        return original

    async def test_resolve_backend_called_once_on_successful_startup(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        try:
            test_state = AppState()
            srv.state = test_state
            stub = _OfficialWorkerStub()
            stub._backend = "official"
            with (
                patch("sidecars.locateanything.server._resolve_backend", return_value="official") as mock_resolve,
                patch("sidecars.locateanything.server._create_worker", return_value=stub) as mock_create,
            ):
                async with srv.lifespan(srv.app):
                    pass
            mock_resolve.assert_called_once()
            mock_create.assert_called_once_with("official")
            self.assertIs(test_state.worker, stub)
            self.assertEqual(test_state.backend, "official")
            self.assertIsNone(test_state.load_error)
        finally:
            srv.state = original_state

    async def test_skip_model_never_calls_worker_factory(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        try:
            test_state = AppState()
            srv.state = test_state
            with (
                patch.dict(os.environ, {"LOCATEANYTHING_SKIP_MODEL": "1"}),
                patch("sidecars.locateanything.server._resolve_backend") as mock_resolve,
                patch("sidecars.locateanything.server._create_worker") as mock_create,
            ):
                async with srv.lifespan(srv.app):
                    pass
            mock_resolve.assert_not_called()
            mock_create.assert_not_called()
            self.assertIsNone(test_state.worker)
            self.assertIsNone(test_state.load_error)
            self.assertIsNone(test_state.backend)
        finally:
            srv.state = original_state

    async def test_skip_true_string_never_calls_worker_factory(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        try:
            test_state = AppState()
            srv.state = test_state
            with (
                patch.dict(os.environ, {"LOCATEANYTHING_SKIP_MODEL": "true"}),
                patch("sidecars.locateanything.server._resolve_backend") as mock_resolve,
                patch("sidecars.locateanything.server._create_worker") as mock_create,
            ):
                async with srv.lifespan(srv.app):
                    pass
            mock_resolve.assert_not_called()
            mock_create.assert_not_called()
        finally:
            srv.state = original_state

    async def test_skip_yes_string_never_calls_worker_factory(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        try:
            test_state = AppState()
            srv.state = test_state
            with (
                patch.dict(os.environ, {"LOCATEANYTHING_SKIP_MODEL": "yes"}),
                patch("sidecars.locateanything.server._resolve_backend") as mock_resolve,
                patch("sidecars.locateanything.server._create_worker") as mock_create,
            ):
                async with srv.lifespan(srv.app):
                    pass
            mock_resolve.assert_not_called()
            mock_create.assert_not_called()
        finally:
            srv.state = original_state

    async def test_valid_worker_failure_attributed_to_backend(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        try:
            test_state = AppState()
            srv.state = test_state
            with (
                patch("sidecars.locateanything.server._resolve_backend", return_value="cpp"),
                patch("sidecars.locateanything.server._create_worker", side_effect=ImportError("lib not found")),
            ):
                async with srv.lifespan(srv.app):
                    pass
            self.assertIsNone(test_state.worker)
            self.assertEqual(test_state.backend, "cpp")
            self.assertIn("cpp", test_state.load_error)
            self.assertIn("ImportError", test_state.load_error)
            self.assertIn("lib not found", test_state.load_error)
        finally:
            srv.state = original_state

    async def test_invalid_backend_selection_captures_valueerror(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        try:
            test_state = AppState()
            srv.state = test_state
            with (
                patch.dict(os.environ, {"LOCATEANYTHING_BACKEND": "invalid"}),
                patch("sidecars.locateanything.server._create_worker") as mock_create,
            ):
                async with srv.lifespan(srv.app):
                    pass
            mock_create.assert_not_called()
            self.assertIsNone(test_state.worker)
            self.assertEqual(test_state.backend, "unknown")
            self.assertIn("unknown", test_state.load_error)
            self.assertIn("ValueError", test_state.load_error)
        finally:
            srv.state = original_state

    async def test_state_reset_at_startup(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        try:
            test_state = AppState()
            test_state.worker = _OfficialWorkerStub()
            test_state.load_error = "old error"
            test_state.backend = "old"
            srv.state = test_state
            with (
                patch.dict(os.environ, {"LOCATEANYTHING_SKIP_MODEL": "1"}),
            ):
                async with srv.lifespan(srv.app):
                    pass
            self.assertIsNone(test_state.worker)
            self.assertIsNone(test_state.load_error)
            self.assertIsNone(test_state.backend)
        finally:
            srv.state = original_state

    async def test_teardown_executes_after_yield(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        teardown_called = False
        try:
            test_state = AppState()
            srv.state = test_state
            with patch.dict(os.environ, {"LOCATEANYTHING_SKIP_MODEL": "1"}):
                async with srv.lifespan(srv.app):
                    teardown_called = True
            self.assertTrue(teardown_called)
        finally:
            srv.state = original_state

    async def test_resolve_backend_called_exactly_once(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        try:
            test_state = AppState()
            srv.state = test_state
            with (
                patch("sidecars.locateanything.server._resolve_backend", return_value="official") as mock_resolve,
                patch("sidecars.locateanything.server._create_worker", return_value=_OfficialWorkerStub()),
            ):
                async with srv.lifespan(srv.app):
                    pass
            self.assertEqual(mock_resolve.call_count, 1)
        finally:
            srv.state = original_state


# ---------------------------------------------------------------------------
# Health endpoint tests
# ---------------------------------------------------------------------------

class HealthEndpointTests(unittest.TestCase):
    def test_health_does_not_crash_for_invalid_backend(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        try:
            test_state = AppState()
            srv.state = test_state
            with patch.dict(os.environ, {"LOCATEANYTHING_BACKEND": "invalid"}, clear=False):
                result = srv.health()
            self.assertIn("backend", result)
            self.assertIn("ready", result)
        finally:
            srv.state = original_state

    def test_health_reports_load_error_truthfully(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        try:
            test_state = AppState()
            test_state.load_error = "backend=cpp: ImportError: lib not found"
            srv.state = test_state
            result = srv.health()
            self.assertEqual(result["error"], "backend=cpp: ImportError: lib not found")
        finally:
            srv.state = original_state

    def test_health_reports_worker_ready_state(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        try:
            test_state = AppState()
            test_state.worker = _OfficialWorkerStub()
            srv.state = test_state
            result = srv.health()
            self.assertTrue(result["ready"])
            self.assertIsNone(result["error"])
        finally:
            srv.state = original_state

    def test_health_uses_retained_backend_when_available(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        try:
            test_state = AppState()
            test_state.backend = "cpp"
            srv.state = test_state
            with patch("sidecars.locateanything.server._resolve_backend") as mock_resolve:
                result = srv.health()
            mock_resolve.assert_not_called()
            self.assertEqual(result["backend"], "cpp")
        finally:
            srv.state = original_state

    def test_health_falls_back_to_resolve_when_backend_is_none(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        try:
            test_state = AppState()
            srv.state = test_state
            with patch("sidecars.locateanything.server._resolve_backend", return_value="official"):
                result = srv.health()
            self.assertEqual(result["backend"], "official")
        finally:
            srv.state = original_state

    def test_health_before_lifespan_is_nonthrowing(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        try:
            test_state = AppState()
            srv.state = test_state
            with patch.dict(os.environ, {"LOCATEANYTHING_BACKEND": "invalid"}, clear=False):
                result = srv.health()
            self.assertEqual(result["backend"], "unknown")
            self.assertFalse(result["ready"])
        finally:
            srv.state = original_state

    def test_health_ready_false_when_worker_none_no_skip(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        try:
            test_state = AppState()
            srv.state = test_state
            result = srv.health()
            self.assertFalse(result["ready"])
        finally:
            srv.state = original_state

    def test_health_ready_true_when_skip_model_active(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        try:
            for skip_value in ("1", "true", "yes"):
                test_state = AppState()
                srv.state = test_state
                with patch.dict(os.environ, {"LOCATEANYTHING_SKIP_MODEL": skip_value}, clear=False):
                    result = srv.health()
                self.assertTrue(
                    result["ready"],
                    f"expected ready=true with LOCATEANYTHING_SKIP_MODEL={skip_value!r}",
                )
        finally:
            srv.state = original_state

    def test_health_reports_in_token_limit_from_worker(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        try:
            test_state = AppState()
            worker = _OfficialWorkerStub()
            worker.processor.image_processor.in_token_limit = 4096
            test_state.worker = worker
            srv.state = test_state
            result = srv.health()
            self.assertEqual(result["inTokenLimit"], 4096)
        finally:
            srv.state = original_state

    def test_health_in_token_limit_none_when_no_worker(self) -> None:
        from sidecars.locateanything import server as srv

        original_state = srv.state
        try:
            test_state = AppState()
            srv.state = test_state
            result = srv.health()
            self.assertIsNone(result["inTokenLimit"])
        finally:
            srv.state = original_state


if __name__ == "__main__":
    unittest.main()
