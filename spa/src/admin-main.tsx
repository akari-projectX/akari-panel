// Admin console entry (/{prefix}/admin): a separate build, served only to
// admin sessions (src/spa.rs).
import { AdminApp } from "./admin-app";
import { mount } from "./mount";

mount(<AdminApp />);
