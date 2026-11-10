import { node } from "@torpor/adapter-node";
import { Site } from "@torpor/build";

const site: Site = new Site();
site.adapter = node;

await site.addRouteFolder("./src/routes");

export default site;
