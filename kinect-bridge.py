#!/usr/bin/env python3
"""
kinect-bridge.py — Kinect v2 depth + body mask -> browser, over a local WebSocket.

Part of The Unlimiter suite. Feeds unlimiter-depth.js.

    pip install websockets numpy
    pip install pykinect2 comtypes        # only for real capture on Windows

    python kinect-bridge.py                  # real sensor
    python kinect-bridge.py --simulate       # synthetic figure, no hardware
    python kinect-bridge.py --scale 2        # halve resolution, quarter bandwidth

Then point the browser tool at  ws://localhost:8787

WHY A BRIDGE AT ALL
    The Kinect v2 is not a webcam. It speaks a proprietary USB 3.0 protocol and
    its depth stream is raw time-of-flight phase data that needs unwrapping
    before it means millimetres. No browser can do that directly, so something
    native has to read the sensor and hand over finished frames.

WHY RAW BINARY AND NOT VIDEO
    Depth must never go through a video codec. Chroma subsampling and DCT
    ringing wreck depth discontinuities exactly at the silhouette edges you
    care about. So this sends uncompressed 16-bit millimetres. At 512x424x30fps
    that is ~156 Mbit/s, which loopback does not even notice.

WIRE FORMAT  (one binary WebSocket message per frame)
    32-byte little-endian header, then payload:
      0  : 4  magic  b'ULD1'
      4  : 1  kind        1 = depth16 + bodyindex8
      5  : 1  flags       bit0 = already mirrored by the sender
      6  : 2  width       uint16
      8  : 2  height      uint16
      10 : 2  minDepthMm  uint16   sensor's usable near plane
      12 : 2  maxDepthMm  uint16   sensor's usable far plane
      14 : 2  (reserved)
      16 : 4  frameIndex  uint32
      20 : 4  (reserved)
      24 : 8  timestampMs float64
    payload = width*height*2 bytes depth  (uint16 LE, millimetres, 0 = no reading)
            + width*height   bytes body   (0..5 = player id, 255 = no body)

    On connect the server also sends one JSON text message describing the
    stream, so a client can size its buffers before the first binary frame.
"""

import argparse, asyncio, json, math, struct, sys, threading, time

try:
    import numpy as np
except ImportError:
    sys.exit("numpy is required:  pip install numpy")

try:
    import websockets
except ImportError:
    sys.exit("websockets is required:  pip install websockets")

MAGIC = b"ULD1"
KIND_DEPTH_BODY = 1
HEADER = 32

NO_BODY = 255


# --------------------------------------------------------------------------
# frame source: the real sensor
# --------------------------------------------------------------------------
class KinectSource:
    """Polls a Kinect v2 through pykinect2 / Kinect for Windows SDK 2.0."""

    def __init__(self):
        try:
            from pykinect2 import PyKinectV2
            from pykinect2 import PyKinectRuntime
        except AssertionError as e:
            # The classic one: pykinect2 asserts a struct size that is wrong on
            # 64-bit Python. It ships a fix in its own issue tracker.
            raise SystemExit(
                "pykinect2 failed an internal size assertion (%s).\n"
                "This is the known 64-bit bug. Open the installed "
                "pykinect2/PyKinectV2.py, find the line\n"
                "    assert sizeof(tagSTATSTG) == 72, sizeof(tagSTATSTG)\n"
                "and change 72 to 80. Then run this again." % e)
        except ImportError as e:
            raise SystemExit(
                "Could not import pykinect2 (%s).\n"
                "Install the Kinect for Windows SDK 2.0, then:\n"
                "    pip install pykinect2 comtypes\n"
                "Or run with --simulate to test the browser side first." % e)

        self.K = PyKinectV2
        flags = (PyKinectV2.FrameSourceTypes_Depth |
                 PyKinectV2.FrameSourceTypes_BodyIndex)
        self.rt = PyKinectRuntime.PyKinectRuntime(flags)

        # give the runtime a moment to bring the sensor up
        t0 = time.time()
        while self.rt.depth_frame_desc.Width == 0 and time.time() - t0 < 5:
            time.sleep(0.1)

        self.width = int(self.rt.depth_frame_desc.Width) or 512
        self.height = int(self.rt.depth_frame_desc.Height) or 424
        self.min_mm = 500
        self.max_mm = 4500
        self._depth = np.zeros(self.width * self.height, np.uint16)
        self._body = np.full(self.width * self.height, NO_BODY, np.uint8)
        print("Kinect v2 online: %dx%d" % (self.width, self.height))

    def read(self):
        """Returns (depth uint16[], body uint8[], got_new)."""
        got = False
        if self.rt.has_new_depth_frame():
            d = self.rt.get_last_depth_frame()
            if d is not None:
                self._depth = np.asarray(d, np.uint16).reshape(-1)
                got = True
        if self.rt.has_new_body_index_frame():
            b = self.rt.get_last_body_index_frame()
            if b is not None:
                self._body = np.asarray(b, np.uint8).reshape(-1)
                got = True
        return self._depth, self._body, got

    def close(self):
        try:
            self.rt.close()
        except Exception:
            pass


# --------------------------------------------------------------------------
# frame source: a synthetic figure, so the browser side can be proven first
# --------------------------------------------------------------------------
class SimSource:
    """A crude walking figure at a believable distance. No hardware needed."""

    def __init__(self, width=512, height=424):
        self.width, self.height = width, height
        self.min_mm, self.max_mm = 500, 4500
        self.t0 = time.time()
        yy, xx = np.mgrid[0:height, 0:width]
        self.xx = xx.astype(np.float32)
        self.yy = yy.astype(np.float32)
        # a back wall with a little tilt, so depth is never flat
        self.wall = (3600 + (self.xx - width / 2) * 0.35
                     + (self.yy - height / 2) * 0.15).astype(np.float32)

    def read(self):
        t = time.time() - self.t0
        w, h = self.width, self.height
        depth = self.wall.copy()
        body = np.full((h, w), NO_BODY, np.uint8)

        # figure drifts side to side and toward/away from the sensor
        cx = w * (0.5 + 0.26 * math.sin(t * 0.45))
        cz = 1900 + 620 * math.sin(t * 0.31)
        breathe = 1.0 + 0.04 * math.sin(t * 2.1)

        # head
        hx, hy, hr = cx, h * 0.26, w * 0.055 * breathe
        head = ((self.xx - hx) ** 2 + ((self.yy - hy) * 1.15) ** 2) < hr * hr
        # torso
        tx, ty = cx, h * 0.56
        tw, th = w * 0.085 * breathe, h * 0.20
        torso = (((self.xx - tx) / tw) ** 2 + ((self.yy - ty) / th) ** 2) < 1.0
        # arms swinging
        sw = math.sin(t * 1.7)
        figure = head | torso
        for side, phase in ((-1, sw), (1, -sw)):
            ax = cx + side * w * 0.085
            ay = h * 0.50
            for k in range(18):
                f = k / 17.0
                px = ax + side * f * w * 0.10 + f * phase * w * 0.07
                py = ay + f * h * 0.20 + f * abs(phase) * h * 0.03
                r = w * 0.022 * (1.0 - 0.3 * f)
                figure |= ((self.xx - px) ** 2 + (self.yy - py) ** 2) < r * r
        # legs
        for side in (-1, 1):
            lx = cx + side * w * 0.035
            for k in range(20):
                f = k / 19.0
                px = lx + side * f * w * 0.02 - side * sw * f * w * 0.05
                py = h * 0.74 + f * h * 0.24
                r = w * 0.026 * (1.0 - 0.25 * f)
                figure |= ((self.xx - px) ** 2 + (self.yy - py) ** 2) < r * r

        # round the body off in depth so it is not a flat cut-out
        rel = np.zeros_like(depth)
        rel[figure] = 1.0
        bulge = np.clip(1.0 - ((self.xx - cx) / (w * 0.13)) ** 2, 0, 1)
        depth[figure] = (cz - 120 * np.sqrt(bulge))[figure]
        body[figure] = 0

        # sensor noise and a few dropouts, because real depth is never clean
        depth += np.random.normal(0, 9, depth.shape).astype(np.float32)
        holes = np.random.random(depth.shape) < 0.004
        depth[holes] = 0

        d16 = np.clip(depth, 0, 65535).astype(np.uint16).reshape(-1)
        return d16, body.reshape(-1), True

    def close(self):
        pass


# --------------------------------------------------------------------------
# shared latest-frame slot: capture thread writes, sender loop reads
# --------------------------------------------------------------------------
class FrameSlot:
    def __init__(self):
        self.lock = threading.Lock()
        self.payload = None
        self.index = 0
        self.stamp = 0.0

    def put(self, payload, stamp):
        with self.lock:
            self.payload = payload
            self.index += 1
            self.stamp = stamp

    def get(self):
        with self.lock:
            return self.payload, self.index, self.stamp


def downscale(depth, body, w, h, factor):
    """Nearest-neighbour decimation. Never average depth — averaging across an
    edge invents a surface halfway between the subject and the wall."""
    if factor <= 1:
        return depth, body, w, h
    nw, nh = w // factor, h // factor
    d = depth.reshape(h, w)[::factor, ::factor][:nh, :nw]
    b = body.reshape(h, w)[::factor, ::factor][:nh, :nw]
    return d.reshape(-1).copy(), b.reshape(-1).copy(), nw, nh


def capture_loop(src, slot, stop, fps, scale, mirror):
    period = 1.0 / max(1.0, fps)
    nxt = time.time()
    while not stop.is_set():
        depth, body, got = src.read()
        if got:
            w, h = src.width, src.height
            if mirror:
                depth = depth.reshape(h, w)[:, ::-1].reshape(-1).copy()
                body = body.reshape(h, w)[:, ::-1].reshape(-1).copy()
            depth, body, w, h = downscale(depth, body, w, h, scale)
            head = struct.pack(
                "<4sBBHHHHHII d",
                MAGIC, KIND_DEPTH_BODY, 1 if mirror else 0,
                w, h, src.min_mm, src.max_mm, 0,
                0, 0, time.time() * 1000.0)
            slot.put(head + depth.tobytes() + body.tobytes(), time.time())
        rest = nxt + period - time.time()
        if rest > 0:
            time.sleep(rest)
        nxt = max(nxt + period, time.time() - period)


# --------------------------------------------------------------------------
async def main():
    ap = argparse.ArgumentParser(description="Kinect v2 -> browser depth bridge")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--scale", type=int, default=1,
                    help="integer decimation: 2 sends quarter the pixels")
    ap.add_argument("--simulate", action="store_true",
                    help="synthetic figure, no sensor required")
    ap.add_argument("--no-mirror", action="store_true",
                    help="send unmirrored; default mirrors so it reads like a mirror")
    args = ap.parse_args()

    src = SimSource() if args.simulate else KinectSource()
    mirror = not args.no_mirror
    sw = src.width // max(1, args.scale)
    sh = src.height // max(1, args.scale)

    hello = json.dumps({
        "protocol": "ULD1", "kind": KIND_DEPTH_BODY,
        "width": sw, "height": sh,
        "minDepthMm": src.min_mm, "maxDepthMm": src.max_mm,
        "fps": args.fps, "mirrored": mirror,
        "source": "simulate" if args.simulate else "kinect-v2",
    })

    slot = FrameSlot()
    stop = threading.Event()
    th = threading.Thread(target=capture_loop,
                          args=(src, slot, stop, args.fps, args.scale, mirror),
                          daemon=True)
    th.start()

    clients = set()

    async def serve(ws):
        clients.add(ws)
        peer = getattr(ws, "remote_address", ("?",))[0]
        print("client connected (%s) — %d total" % (peer, len(clients)))
        try:
            await ws.send(hello)
            last = -1
            period = 1.0 / max(1.0, args.fps)
            while True:
                payload, idx, _ = slot.get()
                if payload is not None and idx != last:
                    last = idx
                    await ws.send(payload)
                await asyncio.sleep(period * 0.5)
        except Exception:
            pass
        finally:
            clients.discard(ws)
            print("client gone — %d left" % len(clients))

    bytes_per = HEADER + sw * sh * 3
    print("serving ws://%s:%d   %dx%d  %.0f fps  %.1f MB/s  (%s)"
          % (args.host, args.port, sw, sh, args.fps,
             bytes_per * args.fps / 1e6,
             "simulated" if args.simulate else "Kinect v2"))
    print("Ctrl-C to stop.")

    try:
        async with websockets.serve(serve, args.host, args.port,
                                    max_size=None, compression=None):
            await asyncio.Future()
    finally:
        stop.set()
        src.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nstopped.")
