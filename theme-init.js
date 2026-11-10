(function(){var t=null;try{t=localStorage.getItem("vitatheme")}catch(e){}
if(!t)t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";
document.documentElement.dataset.theme=t;})();
