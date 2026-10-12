// @ts-check
import { module } from "@prisma/composer";
import tempMailWebService from "./web/service.mjs";

export default module("temp-mail", ({ provision }) => {
  provision(tempMailWebService, { id: "tempmailweb" });
});
