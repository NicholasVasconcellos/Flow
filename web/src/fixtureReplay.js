export async function loadFixture(dispatch) {
  const res = await fetch('/flow-ui-payload.snapshot.json');
  const data = await res.json();
  const frames = data.FLOW_WS_FRAMES;
  for (const frame of frames) {
    dispatch(frame);
  }
}
