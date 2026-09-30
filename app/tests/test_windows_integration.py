import atexit
import pathlib
import tempfile
import threading
import unittest
from unittest import mock

from app import app as server
from app.job_store import JobStore

atexit.unregister(server.cleanup_all_jobs)


class WindowsIntegrationTests(unittest.TestCase):
    def test_cancel_before_burn_process_registration_stops_the_child(self):
        job = {"status": "downloading", "progress": server.empty_progress()}
        child = mock.Mock(stdout=iter(()), returncode=0)
        child.poll.return_value = 0

        def spawn(*args, **kwargs):
            job["status"] = "cancelled"
            return child

        with mock.patch.object(server.subprocess, "Popen", side_effect=spawn), \
             mock.patch.object(server, "terminate_process_tree") as stop, \
             mock.patch.object(server, "persist_job"):
            with self.assertRaises(server.DownloadStopped):
                server._run_subtitle_burn_process("burn", job, ["ffmpeg"], 60, 30, "libx264", False)
        stop.assert_called_once_with(child)
        self.assertIsNone(job["proc"])
        self.assertEqual(job["status"], "cancelled")

    def test_local_burn_survives_database_round_trip_and_restores_its_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            store = JobStore(str(pathlib.Path(directory, "jobs.sqlite3")))
            job = {
                "kind": "local_burn", "status": "interrupted", "url": "", "format": "video",
                "video_path": "视频.mp4", "subtitle_path": "字幕.srt", "container": "mkv",
                "title": "本地硬字幕", "progress": server.empty_progress(), "created_at": 1,
            }
            store.save("burn", job)
            saved = store.load_recent()[0]
            for field in ("kind", "video_path", "subtitle_path", "container"):
                self.assertEqual(saved[field], job[field])
            with mock.patch.object(server, "jobs", {}), \
                 mock.patch.object(server, "download_queue", []), \
                 mock.patch.object(server, "active_downloads", set()), \
                 mock.patch.object(server, "shutdown_event", threading.Event()), \
                 mock.patch.object(server, "get_job_store", return_value=store), \
                 mock.patch.object(server, "cleanup_old_jobs"), \
                 mock.patch.object(server, "persist_job"), \
                 mock.patch.object(server, "get_base_dir", return_value=directory), \
                 mock.patch.object(server, "load_config", return_value={"max_concurrent": 1}), \
                 mock.patch.object(server.threading, "Thread") as worker:
                server.restore_jobs()
                server.process_download_queue()
                self.assertIs(worker.call_args.kwargs["target"], server.run_local_subtitle_burn)
                self.assertEqual(worker.call_args.kwargs["args"][1:4], ("视频.mp4", "字幕.srt", "mkv"))

    def test_cancelled_local_burn_never_starts_or_publishes(self):
        job = {"status": "cancelled", "kind": "local_burn"}
        with mock.patch.object(server, "jobs", {"burn": job}), \
             mock.patch.object(server, "persist_job"), \
             mock.patch.object(server, "process_download_queue"), \
             mock.patch.object(server, "burn_subtitle_into_video") as burn, \
             mock.patch.object(server, "finalize_cached_file") as publish:
            server.run_local_subtitle_burn("burn", "video.mp4", "subtitle.srt")
        burn.assert_not_called()
        publish.assert_not_called()
        self.assertEqual(job["status"], "cancelled")

    def test_local_burn_bad_output_directory_releases_queue_slot(self):
        job = {"status": "starting", "kind": "local_burn"}
        with mock.patch.object(server, "jobs", {"burn": job}), \
             mock.patch.object(server, "active_downloads", {"burn"}), \
             mock.patch.object(server, "get_download_dir", side_effect=OSError("offline disk")), \
             mock.patch.object(server, "persist_job"), \
             mock.patch.object(server, "process_download_queue"):
            server.run_local_subtitle_burn("burn", "video.mp4", "subtitle.srt")
            self.assertNotIn("burn", server.active_downloads)
        self.assertEqual(job["status"], "error")
        self.assertIn("offline disk", job["error"])


if __name__ == "__main__":
    unittest.main()
