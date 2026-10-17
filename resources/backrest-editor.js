/* Shared editor helpers for the Backrest nodes.
 *
 * BackrestEditor.picker() turns a text input into a typed input that can either
 * pick a plan, repository or operation from the Backrest server (fetched through
 * the config node) or take the value from msg/flow/global/etc. A refresh button
 * next to it reloads the list from the server.
 */
(function () {
    if (window.BackrestEditor) return;

    const KINDS = {
        plan: { type: "backrest-plan", label: "Plan", icon: "fa fa-calendar-check-o", list: "plans" },
        repo: { type: "backrest-repo", label: "Repository", icon: "fa fa-database", list: "repos" },
        operation: { type: "backrest-operation", label: "Operation", icon: "fa fa-tasks", list: "operations" }
    };

    // configId -> { include: Set, promise }
    const cache = {};

    function shortStatus(status) {
        return (status || "").replace(/^STATUS_/, "").toLowerCase().replace("_", " ");
    }

    function formatTime(ms) {
        if (!ms) return "";
        const d = new Date(ms);
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
            d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }

    function optionLabel(kind, item) {
        switch (kind) {
            case "plan":
                return item.repo ? `${item.id}  (${item.repo})` : item.id;
            case "repo":
                return item.uri ? `${item.id}  (${item.uri})` : item.id;
            case "operation":
                return `#${item.id} ${item.type}` +
                    (item.planId && item.planId[0] !== "_" ? ` · ${item.planId}` : ` · ${item.repoId}`) +
                    ` · ${shortStatus(item.status)} · ${formatTime(item.time)}`;
        }
        return item.id;
    }

    /** Body for the resources request, including unsaved config node settings. */
    function requestBody(configId, include) {
        const body = { config: configId, include };
        const cfg = RED.nodes.node(configId);
        if (cfg && cfg.changed && cfg.credentials && cfg.credentials.backrest_url) {
            body.url = cfg.credentials.backrest_url;
            body.username = cfg.credentials.username || "";
            body.password = cfg.credentials.password || "";
            body.tls = cfg.tls || "";
        }
        return body;
    }

    /** Fetch plans/repos/operations for a config node, sharing requests between pickers. */
    function fetchResources(configId, include, force) {
        const entry = cache[configId];
        const wanted = new Set(include);
        if (!force && entry && include.every(i => entry.include.has(i))) {
            return entry.promise;
        }
        if (entry && !force) entry.include.forEach(i => wanted.add(i));
        const list = Array.from(wanted);
        const promise = new Promise((resolve, reject) => {
            $.ajax({
                url: "backrest/resources",
                method: "POST",
                contentType: "application/json",
                data: JSON.stringify(requestBody(configId, list)),
                dataType: "json"
            }).done(resolve).fail(xhr => {
                const msg = (xhr.responseJSON && xhr.responseJSON.error) || xhr.statusText || "request failed";
                reject(new Error(msg));
            });
        });
        cache[configId] = { include: wanted, promise };
        promise.catch(() => {
            if (cache[configId] && cache[configId].promise === promise) delete cache[configId];
        });
        return promise;
    }

    /**
     * Set up a picker.
     * opts: {
     *   input: "#node-input-plan",        text input holding the value
     *   typeField: "#node-input-planType", hidden input holding the type
     *   kind: "plan" | "repo" | "operation" (or a function returning one)
     *   types: ["msg", "flow", ...]        other typed input types to offer
     *   any: "Any plan"                    optional label for a "no value" choice
     *   config: "#node-input-config"       config node select
     *   value, type                        saved value and type
     * }
     * Returns { refresh(), setKind(kind) }.
     */
    function picker(opts) {
        const $input = $(opts.input);
        let kind = typeof opts.kind === "function" ? opts.kind() : opts.kind;
        let items = null;      // last loaded list for the current kind
        let loadError = null;

        const $row = $input.closest(".form-row");
        const $button = $('<button type="button" class="red-ui-button backrest-refresh" style="margin-left:4px;" title="Reload from Backrest"><i class="fa fa-refresh"></i></button>');
        const $tip = $('<div class="form-tips backrest-picker-tip" style="margin-top:4px; display:none;"></div>');
        $row.append($tip);

        function anyType() {
            return { value: "backrest-any", label: opts.any, icon: "fa fa-asterisk", hasValue: false };
        }

        function pickerType(current) {
            const def = KINDS[kind];
            const options = (items || []).map(item => ({ value: String(item.id), label: optionLabel(kind, item) }));
            if (current && !options.some(o => o.value === current)) {
                options.unshift({ value: current, label: items ? `${current}  (not found)` : current });
            }
            if (!options.length) {
                options.push({ value: "", label: loadError ? "Couldn't load from Backrest" : "Loading..." });
            }
            return { value: def.type, label: def.label, icon: def.icon, options };
        }

        function buildTypes(current) {
            const types = [];
            if (opts.any) types.push(anyType());
            types.push(pickerType(current));
            return types.concat(opts.types || []);
        }

        function currentPickerValue() {
            const type = $input.typedInput("type");
            return type === KINDS[kind].type ? $input.typedInput("value") : undefined;
        }

        function render() {
            const type = $input.typedInput("type");
            const value = $input.typedInput("value");
            $input.typedInput("types", buildTypes(type === KINDS[kind].type ? value : undefined));
            $input.typedInput("type", type);
            if (type === KINDS[kind].type && value) $input.typedInput("value", value);
        }

        function showTip() {
            const usesPicker = $input.typedInput("type") === KINDS[kind].type;
            if (loadError && usesPicker) {
                $tip.text(`Couldn't load ${KINDS[kind].list} from Backrest: ${loadError}`).show();
            } else if (usesPicker && items && !items.length) {
                $tip.text(`No ${KINDS[kind].list} found on the Backrest server.`).show();
            } else {
                $tip.hide();
            }
        }

        function load(force) {
            const configId = $(opts.config).val();
            if (!configId || configId === "_ADD_") {
                items = [];
                loadError = "choose a Backrest server first";
                render();
                showTip();
                return Promise.resolve();
            }
            $button.prop("disabled", true).find("i").addClass("fa-spin");
            const wantedKind = kind;
            return fetchResources(configId, [KINDS[kind].list], force)
                .then(data => {
                    if (wantedKind !== kind) return;
                    items = data[KINDS[kind].list] || [];
                    loadError = null;
                })
                .catch(err => {
                    if (wantedKind !== kind) return;
                    items = null;
                    loadError = err.message;
                })
                .then(() => {
                    $button.prop("disabled", false).find("i").removeClass("fa-spin");
                    render();
                    showTip();
                });
        }

        // Initial typed input, with the saved value kept even before the list loads.
        const savedType = opts.type || (opts.any ? "backrest-any" : KINDS[kind].type);
        $input.typedInput({
            default: savedType,
            types: buildTypes(savedType === KINDS[kind].type ? opts.value : undefined),
            typeField: opts.typeField
        });
        $input.typedInput("type", savedType);
        if (opts.value !== undefined && opts.value !== null) $input.typedInput("value", opts.value);
        $input.next(".red-ui-typedInput-container").length
            ? $input.next(".red-ui-typedInput-container").after($button)
            : $row.append($button);

        $input.on("change", (event, type) => {
            if (type === KINDS[kind].type && items === null && !loadError) load(false);
            showTip();
        });
        $button.on("click", () => load(true));
        $(opts.config).on("change", () => load(false));
        load(false);

        return {
            refresh: () => load(true),
            /** Switch between plans and repositories (keeps non-picker types as they are). */
            setKind(newKind) {
                if (newKind === kind) return;
                const wasPicker = $input.typedInput("type") === KINDS[kind].type;
                kind = newKind;
                items = null;
                loadError = null;
                $input.typedInput("types", buildTypes());
                if (wasPicker) $input.typedInput("type", KINDS[kind].type);
                load(false);
            },
            value: currentPickerValue
        };
    }

    window.BackrestEditor = { picker, fetchResources, optionLabel };
})();
