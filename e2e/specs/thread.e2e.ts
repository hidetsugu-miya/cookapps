import { account, boot, callsOf, inbox, mock, rowOf, threadDetail, waitForCalls, waitForCount } from "../support";

describe("thread", () => {
  beforeEach(async () => {
    await boot({ inbox: inbox() });
    await waitForCount("#unread-threads li", 2);
  });

  it("opens an unread thread, shows subject and body, and marks it read", async () => {
    const open = await mock("thread", threadDetail("First unread", "Hello from Alice", true));
    const setRead = await mock("set_read", true);
    await rowOf("unread-threads", "First unread").$(".subject").click();
    await expect($("#thread-subject")).toHaveText("First unread");
    await expect($("#messages .plain")).toHaveText("Hello from Alice");
    await waitForCalls(open);
    expect(await callsOf(open)).toContainEqual({ account, id: "t1" });
    await waitForCalls(setRead);
    expect(await callsOf(setRead)).toContainEqual({ account, id: "t1", read: true });
    await waitForCount("#unread-threads li", 1);
  });

  it("opens a read thread without marking it read", async () => {
    const open = await mock("thread", threadDetail("Already read", "Old news", false));
    const setRead = await mock("set_read", true);
    await rowOf("read-threads", "Already read").$(".subject").click();
    await expect($("#thread-subject")).toHaveText("Already read");
    await waitForCalls(open);
    expect(await callsOf(open)).toContainEqual({ account, id: "t3" });
    expect(await callsOf(setRead)).toHaveLength(0);
  });
});
