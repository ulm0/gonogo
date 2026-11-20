// Settings of the machine the tests run on must not decide a test. A host that runs gonogo in a container sets GONOGO_CLEANROOM_NETWORK (and a room's
// agents get GH_CONFIG_DIR), and the Clean Room tests then asked the stand-in docker to `inspect` a container it does not know. A test that needs one
// of them sets it itself (cleanroom.test.ts passes its own env; launcher.test.ts stubs GH_CONFIG_DIR).
delete process.env.GONOGO_CLEANROOM_NETWORK;
