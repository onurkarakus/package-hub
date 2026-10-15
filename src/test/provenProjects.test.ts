import * as assert from "assert";
import { provenProjectNames } from "../services/provenProjects";

suite("Proven projects", () => {
    test("a project is proven only when every list names it", () => {
        const names = provenProjectNames([
            ["Api", "Web"],
            ["api", "Worker"],
            ["Api"],
            ["API", "Web"],
        ]);

        assert.deepStrictEqual(names, ["Api"]);
    });

    test("an empty list proves nothing", () => {
        assert.deepStrictEqual(provenProjectNames([["Api"], []]), []);
        assert.deepStrictEqual(provenProjectNames([]), []);
    });
});
