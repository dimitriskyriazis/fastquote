'use client';

import Script from "next/script";

const disableAutofillScript = `
(function () {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  var selectors = ["form", "input", "textarea", "select"];
  var maskedInputTypes = ["email", "tel"];
  var counter = 0;
  var idAttr = "data-disable-autofill-id";
  var nameAttr = "data-disable-autofill-original-name";
  var typeAttr = "data-disable-autofill-original-type";
  var requestFrame = (window.requestAnimationFrame || window.webkitRequestAnimationFrame || window.mozRequestAnimationFrame || function (cb) {
    return window.setTimeout(cb, 0);
  });
  var AUTOFILL_ANIMATION_NAME = "fastquote-disable-autofill";
  var AUTOFILL_STYLE_ID = "fastquote-disable-autofill-style";

  function injectAutofillStyle() {
    if (document.getElementById(AUTOFILL_STYLE_ID)) {
      return;
    }
    var style = document.createElement("style");
    style.id = AUTOFILL_STYLE_ID;
    var css =
      "@keyframes " + AUTOFILL_ANIMATION_NAME + " { from {} to {} }\\n" +
      "input:-webkit-autofill, input:-webkit-autofill:hover, input:-webkit-autofill:focus, " +
      "textarea:-webkit-autofill, textarea:-webkit-autofill:hover, textarea:-webkit-autofill:focus, " +
      "select:-webkit-autofill, select:-webkit-autofill:hover, select:-webkit-autofill:focus { " +
      "animation-name: " + AUTOFILL_ANIMATION_NAME + "; animation-duration: 0.001s; animation-iteration-count: 1; }";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function forEach(list, callback) {
    if (!list || !callback) {
      return;
    }
    Array.prototype.forEach.call(list, callback);
  }

  function ensureId(element) {
    if (!element || typeof element.getAttribute !== "function") {
      return "";
    }
    var existing = element.getAttribute(idAttr);
    if (existing) {
      return existing;
    }
    counter += 1;
    var id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + counter;
    element.setAttribute(idAttr, id);
    return id;
  }

  function applyAttributes(node) {
    if (!node || node.nodeType !== 1 || !node.tagName) {
      return;
    }

    var element = node;
    var tag = element.tagName.toLowerCase();
    if (selectors.indexOf(tag) === -1) {
      return;
    }

    var uniqueId = ensureId(element);
    if (uniqueId) {
      var autocompleteValue = "disable-" + uniqueId;
      if (element.getAttribute("autocomplete") !== autocompleteValue) {
        element.setAttribute("autocomplete", autocompleteValue);
      }
    }

    if (tag !== "form") {
      if (element.getAttribute("data-disable-autofill-skip") === "true") {
        return;
      }
      if (element.getAttribute("autocorrect") !== "off") {
        element.setAttribute("autocorrect", "off");
      }
      if (element.getAttribute("autocapitalize") !== "off") {
        element.setAttribute("autocapitalize", "off");
      }
      if (element.getAttribute("spellcheck") !== "false") {
        element.setAttribute("spellcheck", "false");
      }

      if (typeof element.getAttribute === "function") {
      var currentName = element.getAttribute("name");
      var normalizedCurrentName = typeof currentName === "string" ? currentName : "";
      var storedName = element.getAttribute(nameAttr);
      if (storedName === null) {
        element.setAttribute(nameAttr, normalizedCurrentName);
        storedName = normalizedCurrentName;
      }
      if (uniqueId) {
        var disabledName = "disabled-" + uniqueId;
        if (element.getAttribute("name") !== disabledName) {
          element.setAttribute("name", disabledName);
        }
      }
      }

      if (tag === "input") {
        var currentType = (element.getAttribute("type") || "text").toLowerCase();
        var storedType = element.getAttribute(typeAttr);
        var canonicalType = storedType ? storedType.toLowerCase() : currentType;

        if (!storedType && maskedInputTypes.indexOf(currentType) !== -1) {
          element.setAttribute(typeAttr, currentType);
          storedType = currentType;
          canonicalType = currentType;
        }

        if (storedType && element.getAttribute("type") !== "text") {
          try {
            element.setAttribute("type", "text");
          } catch (error) {
            // ignore if browser disallows changing type
          }
        }
      }
    }
  }

  function processTree(root) {
    if (!root || root.nodeType !== 1) {
      return;
    }
    applyAttributes(root);
    selectors.forEach(function (selector) {
      if (typeof root.querySelectorAll !== "function") {
        return;
      }
      var matches = root.querySelectorAll(selector);
      forEach(matches, function (match) {
        applyAttributes(match);
      });
    });
  }

  function restoreOriginalNames(form) {
    if (!form || typeof form.querySelectorAll !== "function") {
      return;
    }
    var elements = form.querySelectorAll("[" + nameAttr + "],[" + typeAttr + "]");
    forEach(elements, function (element) {
      var originalName = element.getAttribute(nameAttr);
      if (originalName !== null) {
        if (originalName.length === 0) {
          element.removeAttribute("name");
        } else {
          element.setAttribute("name", originalName);
        }
      }
      var originalType = element.getAttribute(typeAttr);
      if (originalType) {
        try {
          element.setAttribute("type", originalType);
        } catch (error) {
          // ignore
        }
      }
    });
    requestFrame(function () {
      forEach(elements, function (element) {
        applyAttributes(element);
      });
    });
  }

  function handleAutofillAnimation(event) {
    if (event.animationName !== AUTOFILL_ANIMATION_NAME) {
      return;
    }
    var target = event.target;
    if (
      !(target instanceof HTMLInputElement) &&
      !(target instanceof HTMLTextAreaElement) &&
      !(target instanceof HTMLSelectElement)
    ) {
      return;
    }
    requestFrame(function () {
      try {
        target.value = "";
        target.dispatchEvent(new Event("input", { bubbles: true }));
      } catch (error) {
        // ignore
      }
      applyAttributes(target);
    });
  }

  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      if (mutation.type === "childList") {
        forEach(mutation.addedNodes, function (node) {
          processTree(node);
        });
      }
      if (mutation.type === "attributes") {
        applyAttributes(mutation.target);
      }
    });
  });

  function startObserver() {
    if (!document.documentElement) {
      return;
    }
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["autocomplete", "name", "type"],
    });
  }

  injectAutofillStyle();
  document.addEventListener("animationstart", handleAutofillAnimation, true);
  document.addEventListener("webkitAnimationStart", handleAutofillAnimation, true);

  document.addEventListener(
    "submit",
    function (event) {
      var target = event.target;
      if (!target) {
        return;
      }
      var matchesForm =
        typeof target.matches === "function"
          ? target.matches("form")
          : target.tagName && target.tagName.toLowerCase() === "form";
      if (matchesForm) {
        restoreOriginalNames(target);
      }
    },
    true,
  );

  document.addEventListener(
    "focusin",
    function (event) {
      applyAttributes(event.target);
    },
    true,
  );

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      function () {
        processTree(document.documentElement);
        startObserver();
      },
      { once: true },
    );
  } else {
    processTree(document.documentElement);
    startObserver();
  }
})();
`;

export default function DisableAutofill() {
  return (
    <Script
      id="disable-autofill-script"
      strategy="afterInteractive"
      dangerouslySetInnerHTML={{ __html: disableAutofillScript }}
    />
  );
}
