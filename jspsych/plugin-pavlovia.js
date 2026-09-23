/**
 * jsPsych plugin (version > 7.0) for pavlovia.org
 *
 * This plugin handles communications with the pavlovia.org server: it opens and closes sessions,
 * and uploads data to the server.
 *
 * @author Alain Pitiot
 * @version 2022.1.1
 * @copyright (c) 2017-2020 Ilixa Ltd. (http://ilixa.com) (c) 2020-2021 Open Science Tools Ltd.
 *   (https://opensciencetools.org)
 * @license Distributed under the terms of the MIT License
 *
 * Modifs (Alice Jeanningros):
 * - support command "save"
 * - upload to server ONLY when experiment is RUNNING and not in PILOT
 * - in PILOT: always fallback to local download to avoid Pavlovia 403 / "not RUNNING"
 * - add info.data {} to satisfy jsPsych warning
 */

var jsPsychPavlovia = (function (jsPsych) {
  "use strict";

  class PavloviaPlugin {
    constructor(jsPsych) {
      this._jsPsych = jsPsych;
    }

    async trial(display_element, trial) {
      switch ((trial.command || "init").toLowerCase()) {
        case "init": {
          await this._init(trial);
          break;
        }
        case "save": {
          const payload =
            typeof trial.data === "function" ? trial.data() : (trial.data || "");
          const sync = typeof trial.sync !== "undefined" ? trial.sync : false;
          await this._save(trial, payload, sync);
          break;
        }
        case "finish": {
          const data = this._jsPsych.data.get().csv();
          await this._finish(trial, data);
          break;
        }
        default: {
          trial.errorCallback("unknown command: " + trial.command);
        }
      }

      this._jsPsych.finishTrial();
    }

    static defaultErrorCallback(error) {
      console.error("[pavlovia " + PavloviaPlugin.version + "]", error);

      let htmlCode =
        '<h3>[jspsych-pavlovia plugin ' +
        PavloviaPlugin.version +
        "] Error</h3><ul>";
      while (true) {
        if (typeof error === "object" && error && "context" in error) {
          htmlCode += "<li>" + error.context + "</li>";
          error = error.error;
        } else {
          htmlCode += "<li><b>" + error + "</b></li>";
          break;
        }
      }
      htmlCode += "</ul>";
      document.querySelector("body").innerHTML = htmlCode;
    }

    static defaultDataFilter(data) {
      return data;
    }

    async _init(trial, configURL = "config.json") {
      try {
        let response = await this._configure(configURL);
        PavloviaPlugin._config = response.config;
        this._log("init | _configure.response=", response);

        response = await this._openSession();
        this._log("init | _openSession.response=", response);

        PavloviaPlugin._beforeunloadCallback = (event) => {
          event.preventDefault();
          event.returnValue = "";
        };
        window.addEventListener("beforeunload", PavloviaPlugin._beforeunloadCallback);

        // If tab closes: try beacon save/close (best effort).
        window.addEventListener("unload", () => {
          try {
            if (
              PavloviaPlugin._config.session &&
              PavloviaPlugin._config.session.status === "OPEN"
            ) {
              // Save incomplete results only if server allows it (RUNNING + not pilot).
              if (
                PavloviaPlugin._config.experiment &&
                PavloviaPlugin._config.experiment.saveIncompleteResults
              ) {
                try {
                  const data = this._jsPsych.data.get().csv();
                  this._save(trial, data, true); // sync=true => beacon when possible
                } catch (e) {}
              }

              try {
                this._closeSession(false, true);
              } catch (e) {}
            }
          } catch (e) {}
        });
      } catch (error) {
        trial.errorCallback(error);
      }
    }

    async _finish(trial, data) {
      try {
        window.removeEventListener("beforeunload", PavloviaPlugin._beforeunloadCallback);

        const isRunning =
          PavloviaPlugin._config.experiment &&
          PavloviaPlugin._config.experiment.status === "RUNNING";
        const isPilot = PavloviaPlugin._serverMsg.has("__pilotToken");

        const msg = isRunning && !isPilot
          ? "Please wait a moment while the data are uploaded to the pavlovia.org server..."
          : "Pilot mode: results will be downloaded locally (server upload is disabled in PILOT).";

        let container = null;
        try {
          container = this._jsPsych.getDisplayElement();
        } catch (e) {}
        if (!container) container = document.getElementById("jspsych-target");
        if (!container) container = document.body;

        container.innerHTML = '<pre id="pavlovia-data-upload"></pre>';
        const pre = container.querySelector("#pavlovia-data-upload");
        if (pre) pre.textContent = msg;

        const sync = typeof trial.sync !== "undefined" ? trial.sync : false;
        let response = await this._save(trial, data, sync);
        this._log("finish | _save.response=", response);

        if (response && "serverData" in response && response.serverData && "error" in response.serverData) {
          throw response.serverData;
        }

        // close session (best effort)
        response = await this._closeSession(true, false);
        this._log("finish | _closeSession.response=", response);
      } catch (error) {
        trial.errorCallback(error);
      }
    }

    async _configure(configURL) {
      let response = {
        origin: "_configure",
        context: "when configuring the plugin",
      };

      try {
        const configurationResponse = await this._getConfiguration(configURL);

        if ("psychoJsManager" in configurationResponse.config) {
          delete configurationResponse.config.psychoJsManager;
          configurationResponse.config.pavlovia = { URL: "https://pavlovia.org" };
        }

        if (!("experiment" in configurationResponse.config)) throw "missing experiment block in configuration";
        if (!("name" in configurationResponse.config.experiment)) throw "missing name in experiment block in configuration";
        if (!("fullpath" in configurationResponse.config.experiment)) throw "missing fullpath in experiment block in configuration";
        if (!("pavlovia" in configurationResponse.config)) throw "missing pavlovia block in configuration";
        if (!("URL" in configurationResponse.config.pavlovia)) throw "missing URL in pavlovia block in configuration";

        const urlQuery = window.location.search.slice(1);
        const urlParameters = new URLSearchParams(urlQuery);
        urlParameters.forEach((value, key) => {
          if (key.indexOf("__") === 0) PavloviaPlugin._serverMsg.set(key, value);
        });

        return configurationResponse;
      } catch (error) {
        throw { ...response, error };
      }
    }

    _getConfiguration(configURL) {
      let response = {
        origin: "_getConfiguration",
        context: "when reading the configuration file: " + configURL,
      };

      return new Promise(async (resolve, reject) => {
        try {
          const serverResponse = await fetch(configURL, {
            method: "GET",
            mode: "cors",
            cache: "no-cache",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            redirect: "follow",
            referrerPolicy: "no-referrer",
          });
          const serverData = await serverResponse.json();
          resolve({ ...response, config: serverData });
        } catch (error) {
          console.error(error);
          reject({ ...response, error });
        }
      });
    }

    _openSession() {
      let response = {
        origin: "_openSession",
        context:
          "when opening a session for experiment: " +
          (PavloviaPlugin._config.experiment ? PavloviaPlugin._config.experiment.fullpath : ""),
      };

      const formData = new FormData();
      if (PavloviaPlugin._serverMsg.has("__pilotToken")) {
        formData.append("pilotToken", PavloviaPlugin._serverMsg.get("__pilotToken"));
      }
      if (PavloviaPlugin._serverMsg.has("__oauthToken")) {
        formData.append("oauthToken", PavloviaPlugin._serverMsg.get("__oauthToken"));
      }

      return new Promise(async (resolve, reject) => {
        const url = `${PavloviaPlugin._config.pavlovia.URL}/api/v2/experiments/${PavloviaPlugin._config.gitlab.projectId}/sessions`;

        try {
          const serverResponse = await fetch(url, {
            method: "POST",
            mode: "cors",
            cache: "no-cache",
            credentials: "omit", // IMPORTANT: avoid CORS issue with include
            redirect: "follow",
            referrerPolicy: "no-referrer",
            body: formData,
          });

          const txt = await serverResponse.text();
          let serverData = null;
          try {
            serverData = JSON.parse(txt);
          } catch (e) {
            serverData = { raw: txt };
          }

          if (!serverResponse.ok) {
            reject(Object.assign(response, { error: `HTTP ${serverResponse.status}`, serverData }));
            return;
          }

          if (!("token" in serverData)) {
            reject(Object.assign(response, { error: "unexpected answer from server: no token", serverData }));
            return;
          }
          if (!("experiment" in serverData)) {
            reject(Object.assign(response, { error: "unexpected answer from server: no experiment", serverData }));
            return;
          }

          PavloviaPlugin._config.session = { token: serverData.token, status: "OPEN" };
          PavloviaPlugin._config.experiment.status = serverData.experiment.status2;
          PavloviaPlugin._config.experiment.saveFormat = Symbol.for(serverData.experiment.saveFormat);
          PavloviaPlugin._config.experiment.saveIncompleteResults = serverData.experiment.saveIncompleteResults;
          PavloviaPlugin._config.experiment.license = serverData.experiment.license;
          PavloviaPlugin._config.runMode = serverData.experiment.runMode;

          resolve(
            Object.assign(response, {
              token: serverData.token,
              status: serverData.experiment.status2,
              serverData,
            })
          );
        } catch (error) {
          console.error(error);
          reject({ ...response, error });
        }
      });
    }

    _closeSession(isCompleted = true, sync = false) {
      let response = {
        origin: "_closeSession",
        context:
          "when closing the session for experiment: " +
          (PavloviaPlugin._config.experiment ? PavloviaPlugin._config.experiment.fullpath : ""),
      };

      const url =
        PavloviaPlugin._config.pavlovia.URL +
        "/api/v2/experiments/" +
        PavloviaPlugin._config.gitlab.projectId +
        "/sessions/" +
        PavloviaPlugin._config.session.token;

      const formData = new FormData();
      formData.append("isCompleted", isCompleted);

      if (sync) {
        navigator.sendBeacon(url + "/delete", formData);
        PavloviaPlugin._config.session.status = "CLOSED";
        return;
      }

      return new Promise(async (resolve, reject) => {
        try {
          const serverResponse = await fetch(url, {
            method: "DELETE",
            mode: "cors",
            cache: "no-cache",
            credentials: "omit",
            redirect: "follow",
            referrerPolicy: "no-referrer",
            body: formData,
          });
          const serverData = await serverResponse.json();

          PavloviaPlugin._config.session.status = "CLOSED";
          resolve(Object.assign(response, { serverData }));
        } catch (error) {
          console.error(error);
          reject({ ...response, error });
        }
      });
    }

    async _save(trial, data, sync = false) {
      // ensure dataFilter exists
      if (typeof trial.dataFilter !== "function") {
        trial.dataFilter = PavloviaPlugin.defaultDataFilter;
      }

      const date = new Date();
      let dateString =
        date.getFullYear() +
        "-" +
        ("0" + (1 + date.getMonth())).slice(-2) +
        "-" +
        ("0" + date.getDate()).slice(-2) +
        "_";
      dateString +=
        ("0" + date.getHours()).slice(-2) +
        "h" +
        ("0" + date.getMinutes()).slice(-2) +
        "." +
        ("0" + date.getSeconds()).slice(-2) +
        "." +
        date.getMilliseconds();

      const defaultKey =
        (PavloviaPlugin._config.experiment ? PavloviaPlugin._config.experiment.name : "experiment") +
        "_" +
        (trial.participantId || "PARTICIPANT") +
        "_" +
        "SESSION" +
        "_" +
        dateString +
        ".csv";

      const key =
        trial.filename
          ? typeof trial.filename === "function"
            ? trial.filename()
            : trial.filename
          : defaultKey;

      const filteredData = trial.dataFilter(data);

      const isRunning =
        PavloviaPlugin._config.experiment &&
        PavloviaPlugin._config.experiment.status === "RUNNING";
      const isPilot = PavloviaPlugin._serverMsg.has("__pilotToken");

      // ✅ Upload ONLY if server allows it (RUNNING + not pilot + open session)
      if (
        PavloviaPlugin._config.session &&
        PavloviaPlugin._config.session.status === "OPEN" &&
        isRunning &&
        !isPilot
      ) {
        return await this._uploadData(key, filteredData, sync);
      }

      // ✅ PILOT or not RUNNING: local download (reliable)
      this._offerDataForDownload(key, filteredData, "text/csv");
      return {
        origin: "_save",
        context: "when saving results (pilot or not RUNNING)",
        message: "downloaded locally (server upload disabled in PILOT / non-RUNNING)",
      };
    }

    _uploadData(key, value, sync = false) {
      let response = {
        origin: "_uploadData",
        context:
          "when uploading participant' results for experiment: " +
          (PavloviaPlugin._config.experiment ? PavloviaPlugin._config.experiment.fullpath : ""),
      };

      const url =
        PavloviaPlugin._config.pavlovia.URL +
        "/api/v2/experiments/" +
        PavloviaPlugin._config.gitlab.projectId +
        "/sessions/" +
        PavloviaPlugin._config.session.token +
        "/results";

      const formData = new FormData();
      formData.append("key", key);
      formData.append("value", value);

      if (sync) {
        navigator.sendBeacon(url, formData);
        return;
      }

      return new Promise(async (resolve, reject) => {
        try {
          const serverResponse = await fetch(url, {
            method: "POST",
            mode: "cors",
            cache: "no-cache",
            credentials: "omit",
            redirect: "follow",
            referrerPolicy: "no-referrer",
            body: formData,
          });
          const serverData = await serverResponse.json();
          resolve(Object.assign(response, { serverData }));
        } catch (error) {
          console.error(error);
          reject({ ...response, error });
        }
      });
    }

    _log(...messages) {
      console.log("[pavlovia " + PavloviaPlugin.version + "]", ...messages);
    }

    _offerDataForDownload(filename, data, type) {
      const blob = new Blob([data], { type });

      if (window.navigator.msSaveOrOpenBlob) {
        window.navigator.msSaveBlob(blob, filename);
      } else {
        const elem = window.document.createElement("a");
        elem.href = window.URL.createObjectURL(blob);
        elem.download = filename;
        document.body.appendChild(elem);
        elem.click();
        document.body.removeChild(elem);
      }
    }
  }

  PavloviaPlugin.version = "2022.1.1";
  PavloviaPlugin._config = {};
  PavloviaPlugin._beforeunloadCallback = null;
  PavloviaPlugin._serverMsg = new Map();

  PavloviaPlugin.info = {
    name: "pavlovia",
    version: PavloviaPlugin.version,
    description: "communication with pavlovia.org",
    parameters: {
      command: {
        type: jsPsych.ParameterType.STRING,
        default: "init",
        description: 'The pavlovia command: "init", "save", or "finish"',
      },
      participantId: {
        type: jsPsych.ParameterType.STRING,
        default: "PARTICIPANT",
      },
      filename: {
        type: jsPsych.ParameterType.STRING,
        default: "",
      },
      data: {
        type: jsPsych.ParameterType.STRING,
        default: "",
      },
      sync: {
        type: jsPsych.ParameterType.BOOL,
        default: false,
      },
      errorCallback: {
        type: jsPsych.ParameterType.FUNCTION,
        default: PavloviaPlugin.defaultErrorCallback,
      },
      dataFilter: {
        type: jsPsych.ParameterType.FUNCTION,
        default: PavloviaPlugin.defaultDataFilter,
      },
    },
    // ✅ avoids jsPsych v9 warnings
    data: {},
  };

  return PavloviaPlugin;
})(jsPsychModule);
