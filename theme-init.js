(function(){var t=null;try{t=localStorage.getItem("vitatheme")}catch(e){}
if(t!=="light"&&t!=="dark")t="dark";
document.documentElement.dataset.theme=t;})();
